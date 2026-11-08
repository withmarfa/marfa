//! The routers and the committed `openapi.json`, held to each other.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value;
use tempfile::TempDir;

use super::root::DOCUMENT;
use super::{control_doors, public_doors};
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
    ("GET /auth/sign-in", "the sign-in page"),
    ("POST /auth/sign-in", "its form post"),
    (
        "POST /auth/sign-in/email",
        "password sign-in, which the sign-in page calls",
    ),
    ("POST /auth/sign-out", "a browser's sign-out"),
    (
        "GET /auth/get-session",
        "the browser session a cookie names",
    ),
    ("POST /auth/revoke-sessions", "ends every browser session"),
    (
        "POST /auth/revoke-other-sessions",
        "ends every browser session but the caller's",
    ),
    ("POST /auth/change-password", "the owner's password change"),
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
];

/// Published operations the router does not serve yet. An entry that becomes
/// served fails the test, so the list only shrinks.
const NOT_YET_SERVED: &[&str] = &[
    "DELETE /blobs/{hash}/copies/{store}",
    "DELETE /connectors/{id}",
    "DELETE /connectors/{id}/endpoints/{endpoint_id}",
    "DELETE /connectors/{id}/hold",
    "DELETE /connectors/{id}/state",
    "DELETE /webhooks/{id}",
    "GET /attention",
    "GET /blobs/orphans",
    "GET /blobs/stores",
    "GET /blobs/{hash}",
    "GET /blobs/{hash}/copies",
    "GET /blobs/{hash}/url",
    "GET /connectors",
    "GET /connectors/{id}",
    "GET /connectors/{id}/agreements",
    "GET /connectors/{id}/deliveries",
    "GET /connectors/{id}/deliveries/{delivery_id}/body",
    "GET /connectors/{id}/endpoints",
    "GET /connectors/{id}/runs",
    "GET /connectors/{id}/state",
    "GET /events",
    "GET /export",
    "GET /folders",
    "GET /folders/{id}/status",
    "GET /items/bulk-actions/jobs/{id}",
    "GET /metrics",
    "GET /occurrences",
    "GET /overview",
    "GET /owner/picture",
    "GET /webhooks",
    "GET /webhooks/{id}",
    "GET /webhooks/{id}/deliveries",
    "PATCH /folders/{id}",
    "PATCH /profile",
    "PATCH /webhooks/{id}",
    "POST /blobs",
    "POST /connectors",
    "POST /connectors/{id}/agreements",
    "POST /connectors/{id}/agreements/lookup",
    "POST /connectors/{id}/deliveries/handled",
    "POST /connectors/{id}/endpoints",
    "POST /connectors/{id}/heartbeat",
    "POST /connectors/{id}/hold",
    "POST /connectors/{id}/runs",
    "POST /folders",
    "POST /folders/{id}/revoke",
    "POST /items/bulk-actions",
    "POST /items/bulk-actions/jobs/{id}/cancel",
    "POST /restore",
    "POST /types/{id}/move",
    "POST /webhooks",
    "POST /webhooks/{id}/deliveries/{delivery_id}/redeliver",
    "PUT /connectors/{id}/state",
    "PUT /folders/{id}/status",
    "PUT /owner/picture",
    "PUT /profile/picture",
];

const METHODS: [&str; 5] = ["get", "put", "post", "patch", "delete"];

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

async fn served() -> BTreeSet<String> {
    let dir = TempDir::new().unwrap();
    let database = dir.path().join("marfa.db");
    let blobs = dir.path().join("blobs");
    let socket = dir.path().join("s.sock");
    let settings = Settings::read(Environment::from_pairs(&[
        ("SQLITE_PATH", database.to_str().unwrap()),
        ("BLOB_PATH", blobs.to_str().unwrap()),
        ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ("MARFA_TEST_HOOKS", "true"),
    ]))
    .unwrap();
    let app: Arc<App> = App::start(settings).await.unwrap();
    public_doors(app.clone())
        .served()
        .into_iter()
        .chain(control_doors(&app).served())
        .map(|door| format!("{} {}", door.method, door.path))
        .collect()
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

fn unserved(served: &BTreeSet<String>, published: &BTreeSet<String>) -> Vec<String> {
    let waiting = listed(NOT_YET_SERVED);
    published
        .iter()
        .filter(|route| !served.contains(*route) && !waiting.contains(*route))
        .cloned()
        .collect()
}

fn unlisted(served: &BTreeSet<String>, published: &BTreeSet<String>) -> Vec<String> {
    let known = unpublished();
    served
        .iter()
        .filter(|route| !published.contains(*route) && !known.contains(*route))
        .cloned()
        .collect()
}

#[tokio::test]
async fn every_served_route_is_published_or_listed_as_unpublished() {
    let (served, published) = (served().await, published());
    assert!(served.contains("GET /items/{id}") && published.contains("GET /items/{id}"));
    assert_eq!(
        unlisted(&served, &published),
        Vec::<String>::new(),
        "publish each in openapi.json, or list it in UNPUBLISHED with why"
    );
}

#[tokio::test]
async fn every_published_operation_is_served_or_listed_as_not_yet_served() {
    let (served, published) = (served().await, published());
    assert_eq!(
        unserved(&served, &published),
        Vec::<String>::new(),
        "serve each, or list it in NOT_YET_SERVED"
    );
}

#[tokio::test]
async fn the_lists_hold_only_what_they_say() {
    let (served, published) = (served().await, published());
    let still_waiting: Vec<_> = NOT_YET_SERVED
        .iter()
        .filter(|route| !published.contains(**route) || served.contains(**route))
        .collect();
    assert!(
        still_waiting.is_empty(),
        "no longer unserved, or not published: {still_waiting:?}"
    );
    let stale: Vec<_> = UNPUBLISHED
        .iter()
        .filter(|(route, _)| !served.contains(*route) || published.contains(*route))
        .collect();
    assert!(stale.is_empty(), "not served, or published: {stale:?}");
}
