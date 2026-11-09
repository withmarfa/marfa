//! The routers and the committed `openapi.json`, held to each other.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

use super::doors::Doors;
use super::root::DOCUMENT;
use super::{control, control_doors, count_doors, item_doors, overview_doors, public_doors};
use crate::app::App;
use crate::settings::{Environment, Settings};

/// Routes served and not published, each with why.
const UNPUBLISHED: &[(&str, &str)] = &[
    ("GET /openapi.json", "the document itself"),
    (
        "GET /.well-known/oauth-authorization-server/auth",
        "RFC 8414 discovery",
    ),
    (
        "GET /auth/.well-known/oauth-authorization-server",
        "the issuer-suffixed spelling of the same document",
    ),
    (
        "GET /.well-known/oauth-protected-resource",
        "RFC 9728 resource metadata, which a bearer challenge points at",
    ),
    (
        "GET /.well-known/oauth-protected-resource/{*path}",
        "the same for the resource at a path",
    ),
    (
        "POST /mcp",
        "the Model Context Protocol endpoint, which its own protocol describes",
    ),
    ("GET /mcp", "answers 405: the endpoint opens no stream"),
    ("DELETE /mcp", "answers 405: the endpoint holds no session"),
    (
        "POST /mcp/schema",
        "the Model Context Protocol endpoint of the schema tools, which its own protocol describes",
    ),
    (
        "GET /mcp/schema",
        "answers 405: the endpoint opens no stream",
    ),
    (
        "DELETE /mcp/schema",
        "answers 405: the endpoint holds no session",
    ),
    (
        "POST /mcp/admin",
        "the Model Context Protocol endpoint of the admin tools, which its own protocol describes",
    ),
    (
        "GET /mcp/admin",
        "answers 405: the endpoint opens no stream",
    ),
    (
        "DELETE /mcp/admin",
        "answers 405: the endpoint holds no session",
    ),
    ("GET /auth/sign-in", "the sign-in page"),
    ("POST /auth/sign-in", "its form post"),
    (
        "POST /auth/sign-in/email",
        "password sign-in, which the sign-in page calls",
    ),
    ("POST /auth/sign-out", "a browser's sign-out"),
    (
        "POST /auth/confirm",
        "the dialog's answer, which renews a stale browser session",
    ),
    (
        "GET /auth/passkey/generate-register-options",
        "the owner's passkey registration challenge",
    ),
    (
        "POST /auth/passkey/verify-registration",
        "the owner's passkey registration",
    ),
    (
        "GET /auth/passkey/generate-authenticate-options",
        "a passkey sign-in challenge",
    ),
    (
        "POST /auth/passkey/verify-authentication",
        "passkey sign-in",
    ),
    ("GET /auth/owner/passkeys", "the owner's passkeys page"),
    (
        "GET /auth/error",
        "the OAuth failure page a redirect lands on",
    ),
    (
        "GET /auth/oauth2/authorize",
        "an app's authorization request",
    ),
    ("GET /auth/authorize", "the consent screen"),
    ("POST /auth/authorize/decision", "its decision"),
    ("POST /auth/oauth2/token", "the token exchange, every grant"),
    ("POST /auth/oauth2/revoke", "RFC 7009 revocation"),
    (
        "OPTIONS /auth/oauth2/register",
        "the preflight of the published registration",
    ),
    ("POST /auth/device/code", "RFC 8628 device authorization"),
    ("GET /auth/device", "the device-code entry page"),
    ("POST /auth/device", "its form post"),
    ("GET /auth/device/consent", "the device consent screen"),
    ("POST /auth/device/consent", "its decision"),
    ("GET /setup", "first-party owner setup page"),
    (
        "POST /setup/claim",
        "same-origin owner setup form submission",
    ),
    (
        "POST /setup/exchange",
        "single-use browser handoff exchange",
    ),
    (
        "GET /config/settings",
        "every setting with where its value comes from",
    ),
    (
        "POST /config/address-check",
        "checks a public address before it is saved",
    ),
    (
        "HEAD /blobs/{hash}",
        "the headers of the published read, without its bytes",
    ),
    (
        "GET /blobs/{hash}/fetch",
        "the signed link GET /blobs/{hash}/url answers",
    ),
    ("HEAD /blobs/{hash}/fetch", "the headers of that link"),
    (
        "GET /_control/setup/status",
        "the private control socket, outside the HTTP contract",
    ),
    ("POST /_control/setup/claim", "the private control socket"),
    ("POST /_control/setup/code", "the private control socket"),
    ("POST /_control/setup/ticket", "the private control socket"),
    ("POST /_control/owner/recover", "the private control socket"),
    (
        "GET /_control/owner/passkeys/add-url",
        "the private control socket",
    ),
    (
        "GET /_control/test/clock",
        "the private control socket, with test hooks on",
    ),
    (
        "POST /_control/test/clock",
        "the private control socket, with test hooks on",
    ),
    (
        "GET /_control/test/faults",
        "the private control socket, with test hooks on",
    ),
    (
        "PUT /_control/test/faults",
        "the private control socket, with test hooks on",
    ),
    (
        "DELETE /_control/test/faults",
        "the private control socket, with test hooks on",
    ),
    (
        "GET /_control/test/blob-stores",
        "the private control socket, with test hooks on",
    ),
];

/// Published operations the router does not serve yet. An entry that becomes
/// served fails the test, so the list only shrinks.
const NOT_YET_SERVED: &[&str] = &[
    "DELETE /connectors/{id}/endpoints/{endpoint_id}",
    "GET /attention",
    "GET /connectors/{id}/deliveries",
    "GET /connectors/{id}/deliveries/{delivery_id}/body",
    "GET /connectors/{id}/endpoints",
    "GET /export",
    "GET /folders",
    "GET /folders/{id}/status",
    "GET /items/bulk-actions/jobs/{id}",
    "GET /metrics",
    "PATCH /folders/{id}",
    "POST /connectors/{id}/deliveries/handled",
    "POST /connectors/{id}/endpoints",
    "POST /folders",
    "POST /folders/{id}/revoke",
    "POST /items/bulk-actions",
    "POST /items/bulk-actions/jobs/{id}/cancel",
    "POST /restore",
    "POST /types/{id}/move",
    "PUT /folders/{id}/status",
];

const METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];

const CONTROL_PREFIX: &str = "/_control/";

const LOCAL_MARK: &str = "x-marfa-local-command";

/// Doors that take no credential, which the private socket answers as it answers anyone.
const OPEN: &[&str] = &["GET /", "GET /health", "POST /owner"];

/// Doors on the shared router that the socket serves and refuses local authority, each with why.
/// The doors behind a type map are not listed: `content` finds them.
const REFUSES_LOCAL: &[(&str, &str)] = &[
    (
        "GET /keys/current",
        "describes the key that sent the request",
    ),
    ("POST /connectors", "a connector registers under a key"),
    (
        "POST /connectors/{id}/heartbeat",
        "the connector's own key alone",
    ),
    (
        "POST /connectors/{id}/runs",
        "the connector's own key alone",
    ),
    (
        "POST /connectors/{id}/hold",
        "the connector's own key alone",
    ),
    (
        "DELETE /connectors/{id}/hold",
        "the connector's own key alone",
    ),
    (
        "GET /connectors/{id}/state",
        "the connector's own key alone",
    ),
    (
        "PUT /connectors/{id}/state",
        "the connector's own key alone",
    ),
    (
        "POST /connectors/{id}/agreements",
        "the connector's own key alone",
    ),
    (
        "GET /connectors/{id}/agreements",
        "the connector's own key alone",
    ),
    (
        "POST /connectors/{id}/agreements/lookup",
        "the connector's own key alone",
    ),
    ("POST /webhooks", "a subscription belongs to its maker"),
    (
        "PATCH /webhooks/{id}",
        "a subscription belongs to its maker",
    ),
    (
        "DELETE /webhooks/{id}",
        "a subscription belongs to its maker",
    ),
];

fn published() -> BTreeSet<String> {
    let document: Value = serde_json::from_str(DOCUMENT).unwrap();
    let mut found = BTreeSet::new();
    for (path, item) in document["paths"].as_object().unwrap() {
        for method in METHODS {
            if item.get(method).is_some() {
                found.insert(format!("{} {path}", method.to_uppercase()));
            }
        }
    }
    found
}

/// What each listener answers.
struct Served {
    _dir: TempDir,
    public: BTreeSet<String>,
    control: BTreeSet<String>,
    /// The doors behind a type map or a count, which answer a credential and never the local command.
    content: BTreeSet<String>,
    socket: Router,
}

fn routes(doors: Doors) -> BTreeSet<String> {
    doors
        .served()
        .into_iter()
        .map(|door| format!("{} {}", door.method, door.path))
        .collect()
}

fn path(route: &str) -> &str {
    route.split_once(' ').unwrap().1
}

async fn served() -> Served {
    let dir = TempDir::new().unwrap();
    let database = dir.path().join("marfa.db");
    let blobs = dir.path().join("blobs");
    let socket = dir.path().join("s.sock");
    let settings = Settings::read(Environment::from_pairs(&[
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
        ("RATE_LIMIT_ENABLED", "false"),
    ]))
    .unwrap();
    let app: Arc<App> = App::start(settings).await.unwrap();
    Served {
        public: routes(public_doors(app.clone())),
        control: routes(control_doors(&app)),
        content: [
            routes(item_doors(app.clone())),
            routes(overview_doors(app.clone())),
            routes(count_doors(app.clone())),
        ]
        .into_iter()
        .flatten()
        .collect(),
        socket: control(app),
        _dir: dir,
    }
}

fn listed(routes: &[&str]) -> BTreeSet<String> {
    routes.iter().map(|route| (*route).to_owned()).collect()
}

fn unpublished() -> BTreeSet<String> {
    UNPUBLISHED
        .iter()
        .map(|(route, _)| (*route).to_owned())
        .collect()
}

fn controlled(route: &str) -> bool {
    path(route).starts_with(CONTROL_PREFIX)
}

/// Public routes that are neither published nor listed.
fn unlisted(served: &Served, published: &BTreeSet<String>) -> Vec<String> {
    let known = unpublished();
    served
        .public
        .iter()
        .filter(|route| !published.contains(*route) && !known.contains(*route))
        .cloned()
        .collect()
}

/// Control routes the unpublished list does not name.
fn unlisted_control(served: &Served) -> Vec<String> {
    let known = unpublished();
    served
        .control
        .iter()
        .filter(|route| controlled(route) && !known.contains(*route))
        .cloned()
        .collect()
}

/// Control routes outside `/_control/` that the public listener does not serve.
fn strays(served: &Served) -> Vec<String> {
    served
        .control
        .iter()
        .filter(|route| !controlled(route) && !served.public.contains(*route))
        .cloned()
        .collect()
}

fn unserved(served: &Served, published: &BTreeSet<String>) -> Vec<String> {
    let waiting = listed(NOT_YET_SERVED);
    published
        .iter()
        .filter(|route| !served.public.contains(*route) && !waiting.contains(*route))
        .cloned()
        .collect()
}

#[tokio::test]
async fn every_served_route_is_published_or_listed_as_unpublished() {
    let (served, published) = (served().await, published());
    assert!(served.public.contains("GET /items/{id}") && published.contains("GET /items/{id}"));
    let exposed: Vec<_> = served.public.iter().filter(|r| controlled(r)).collect();
    assert!(
        exposed.is_empty(),
        "served on the public listener: {exposed:?}"
    );
    assert_eq!(
        unlisted(&served, &published),
        Vec::<String>::new(),
        "publish each in openapi.json, or list it in UNPUBLISHED with why"
    );
    assert_eq!(
        unlisted_control(&served),
        Vec::<String>::new(),
        "list each in UNPUBLISHED"
    );
    assert_eq!(
        strays(&served),
        Vec::<String>::new(),
        "the control listener serves only /_control/ routes and the public ones"
    );
}

#[tokio::test]
async fn every_published_operation_is_served_or_listed_as_not_yet_served() {
    let (served, published) = (served().await, published());
    assert_eq!(
        unserved(&served, &published),
        Vec::<String>::new(),
        "serve each on the public listener, or list it in NOT_YET_SERVED"
    );
}

#[tokio::test]
async fn the_lists_hold_only_what_they_say() {
    let (served, published) = (served().await, published());
    let still_waiting: Vec<_> = NOT_YET_SERVED
        .iter()
        .filter(|route| !published.contains(**route) || served.public.contains(**route))
        .collect();
    assert!(
        still_waiting.is_empty(),
        "no longer unserved, or not published: {still_waiting:?}"
    );
    let stale: Vec<_> = UNPUBLISHED
        .iter()
        .filter(|(route, _)| {
            if controlled(route) {
                !served.control.contains(*route)
            } else {
                !served.public.contains(*route) || published.contains(*route)
            }
        })
        .collect();
    assert!(
        stale.is_empty(),
        "not served on its listener, or published: {stale:?}"
    );
}

fn marked(document: &Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for (path, item) in document["paths"].as_object().unwrap() {
        for method in METHODS {
            if item[method][LOCAL_MARK] == Value::Bool(true) {
                found.insert(format!("{} {path}", method.to_uppercase()));
            }
        }
    }
    found
}

/// Published doors the socket serves and takes local authority at.
fn taken(served: &Served, published: &BTreeSet<String>) -> BTreeSet<String> {
    let refused = listed_refusals();
    served
        .control
        .iter()
        .filter(|route| published.contains(*route))
        .filter(|route| !served.content.contains(*route) && !refused.contains(*route))
        .filter(|route| !OPEN.contains(&route.as_str()))
        .cloned()
        .collect()
}

fn listed_refusals() -> BTreeSet<String> {
    REFUSES_LOCAL
        .iter()
        .map(|(route, _)| (*route).to_owned())
        .collect()
}

#[tokio::test]
async fn the_mark_is_on_exactly_the_operations_the_socket_takes() {
    let (served, published) = (served().await, published());
    let document: Value = serde_json::from_str(DOCUMENT).unwrap();
    let marks = marked(&document);
    let waiting = listed(NOT_YET_SERVED);
    let taken = taken(&served, &published);
    assert!(
        taken.contains("GET /auth/grants") && !marks.is_empty(),
        "the witness is a door that is served and taken"
    );
    // A door the server does not serve yet cannot be asked, so its mark waits for it.
    let judged: BTreeSet<_> = marks.difference(&waiting).cloned().collect();
    assert_eq!(
        taken.difference(&judged).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "the socket takes these: mark each with x-marfa-local-command"
    );
    assert_eq!(
        judged.difference(&taken).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "marked, but the socket does not take them: remove the mark, or list the door in REFUSES_LOCAL"
    );
    for route in OPEN {
        let (method, at) = route.split_once(' ').unwrap();
        let operation = &document["paths"][at][method.to_lowercase()];
        assert!(
            operation["security"].is_null() && operation[LOCAL_MARK].is_null(),
            "{route} takes no credential, so it carries neither"
        );
    }
}

#[tokio::test]
async fn the_lists_of_refused_doors_hold_only_what_they_say() {
    let (served, published) = (served().await, published());
    let stale: Vec<_> = REFUSES_LOCAL
        .iter()
        .map(|(route, _)| *route)
        .chain(OPEN.iter().copied())
        .filter(|route| !served.control.contains(*route) || !published.contains(*route))
        .collect();
    assert!(
        stale.is_empty(),
        "not served on the socket, or not published: {stale:?}"
    );
}

const AN_ID: &str = "01890000-0000-7000-8000-000000000000";

fn concrete(route: &str) -> (Method, String) {
    let (method, path) = route.split_once(' ').unwrap();
    let mut filled = String::new();
    let mut rest = path;
    while let Some((before, after)) = rest.split_once('{') {
        let (name, tail) = after.split_once('}').unwrap();
        filled.push_str(before);
        match name {
            "hash" => filled.push_str(&"0".repeat(64)),
            "name" | "tag" | "namespace" | "store" => filled.push('x'),
            _ => filled.push_str(AN_ID),
        }
        rest = tail;
    }
    filled.push_str(rest);
    (method.parse().unwrap(), filled)
}

async fn status_of(socket: &Router, route: &str) -> StatusCode {
    let (method, path) = concrete(route);
    let mut builder = Request::builder().method(method.clone()).uri(path);
    let body = if matches!(method, Method::GET | Method::DELETE | Method::HEAD) {
        Body::empty()
    } else {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from("{}")
    };
    let response = socket
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    response.status()
}

#[tokio::test]
async fn the_socket_refuses_the_doors_behind_a_map_and_no_door_it_takes() {
    let (served, published) = (served().await, published());
    let witness = status_of(&served.socket, "GET /items").await;
    assert_eq!(witness, StatusCode::UNAUTHORIZED);
    let mut wrong = Vec::new();
    for route in served.content.iter().filter(|r| published.contains(*r)) {
        let status = status_of(&served.socket, route).await;
        if status != StatusCode::UNAUTHORIZED {
            wrong.push(format!("{route} answered {status}"));
        }
    }
    for route in taken(&served, &published) {
        let status = status_of(&served.socket, &route).await;
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            wrong.push(format!("{route} answered {status}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "a door behind a map takes local authority, or a taken door refuses it: {wrong:?}"
    );
}
