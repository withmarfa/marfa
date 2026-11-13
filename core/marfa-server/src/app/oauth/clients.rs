use std::sync::Arc;

use serde_json::json;
use tokio::sync::Semaphore;

use super::client::Registration;
use super::metadata_document::{self, Failure, Fetcher};
use super::scope::{EMAIL_WRITE_REFUSED, OFFLINE_ACCESS, Registries, ScopeSet, covers, narrow};
use super::store::{self, Client};
use super::{Answered, Problem};
use crate::app::App;
use crate::app::audit::{self, Entry};
use crate::app::auth::limits::{admit, document_lanes};
use crate::app::auth::{Visit, configured_origins};
use crate::app::catalog::{self, Snapshot};
use crate::app::keys::digest_of;
use crate::app::refusal::{Refusal, Result};
use crate::app::unit::Unit;
use crate::db::Write;

const MOST_FETCHES_AT_ONCE: usize = 4;
const DOCUMENT_FRESH_MS: i64 = 3_600_000;
pub(super) const CLIENT_CREATED: &str = "auth.client.created";

#[derive(Debug)]
pub struct Documents {
    permits: Arc<Semaphore>,
}

impl Default for Documents {
    fn default() -> Documents {
        Documents {
            permits: Arc::new(Semaphore::new(MOST_FETCHES_AT_ONCE)),
        }
    }
}

pub(super) fn email_write_refused() -> Problem {
    Problem::new("invalid_scope", EMAIL_WRITE_REFUSED)
}

fn no_such_client() -> Problem {
    Problem::new("invalid_client", "No client has this client_id.")
}

fn busy() -> Problem {
    Problem::new(
        "temporarily_unavailable",
        "The client's metadata document cannot be read just now.",
    )
}

pub async fn resolve(app: &Arc<App>, id: &str, visit: &Visit) -> Result<Answered<Client>> {
    let fetcher = Fetcher::new(app.faults.clone());
    resolve_by(app, id, visit, move |id| fetcher.fetch(id)).await
}

async fn resolve_by<F>(
    app: &Arc<App>,
    id: &str,
    visit: &Visit,
    fetch: F,
) -> Result<Answered<Client>>
where
    F: FnOnce(&str) -> std::result::Result<Vec<u8>, Failure> + Send + 'static,
{
    let row = id.to_string();
    let (stored, fresh_until) = app
        .db
        .read(move |tx| {
            Ok((
                store::client(tx, &row)?,
                store::document_fresh_until(tx, &row)?,
            ))
        })
        .await?;
    if !metadata_document::is_url(id) {
        return Ok(stored.ok_or_else(no_such_client));
    }
    let now = app.clock.instant();
    if let (Some(client), true) = (&stored, fresh_until.is_some_and(|until| until > now)) {
        return Ok(Ok(client.clone()));
    }
    if is_own_origin(app, id) || metadata_document::check_url(id).is_err() {
        return Ok(Err(refused_document()));
    }
    let keep_or_busy = |stored: Option<Client>| Ok(stored.ok_or_else(busy));
    let wait = admit(app, &document_lanes(visit.address));
    let permit = app.documents.permits.clone().try_acquire_owned();
    let (None, Ok(permit)) = (wait, permit) else {
        return keep_or_busy(stored);
    };
    let owned = id.to_string();
    let fetched = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        fetch(&owned)
    })
    .await
    .map_err(|_| Refusal::internal("a metadata document's fetch ended early"))?;
    let body = match fetched {
        Ok(body) => body,
        Err(Failure::Unavailable(_)) => return keep_or_busy(stored),
        Err(Failure::Refused(_)) => return Ok(Err(refused_document())),
    };
    let Ok(registration) = metadata_document::parse_document(id, &body) else {
        return Ok(Err(refused_document()));
    };
    keep_document(app, id, registration, visit).await.map(Ok)
}

fn refused_document() -> Problem {
    Problem::new("invalid_client", "This client_id cannot be used.")
}

fn is_own_origin(app: &App, id: &str) -> bool {
    let origin = url::Url::parse(id).map(|url| url.origin().ascii_serialization());
    origin.is_ok_and(|origin| {
        app.addresses()
            .all()
            .iter()
            .any(|address| address.origin() == origin)
    })
}

/// A ceiling widened since the document was read stays.
async fn keep_document(
    app: &Arc<App>,
    id: &str,
    mut registration: Registration,
    visit: &Visit,
) -> Result<Client> {
    let id = id.to_string();
    let ip = visit.client_ip();
    let now = app.clock.instant();
    let at = now.text();
    app.db
        .write(Write::caller(CLIENT_CREATED), move |tx| {
            let before = store::client(tx, &id)?;
            if let Some(before) = &before {
                for literal in before.registration.scope.literals() {
                    registration.scope.insert(literal);
                }
            }
            store::put_client(tx, &id, &registration, now)?;
            store::narrow_destinations(tx, &id, &registration)?;
            store::note_document(tx, &id, now, now.plus_ms(DOCUMENT_FRESH_MS)?)?;
            if before.is_none() {
                audit::record_from(
                    tx,
                    &at,
                    None,
                    ip.as_deref(),
                    Entry {
                        action: CLIENT_CREATED,
                        resource_type: "oauth_client",
                        resource_id: Some(&id),
                        details: Some(json!({ "client_id": id, "source": "metadata_document" })),
                    },
                )?;
            }
            store::client(tx, &id)?.ok_or_else(|| Refusal::internal("a client did not store"))
        })
        .await
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Judged {
    pub kept: ScopeSet,
    pub unknown: Vec<String>,
    pub outside: Vec<String>,
    pub widened: ScopeSet,
}

impl Judged {
    pub fn narrowed(&self) -> bool {
        !self.unknown.is_empty() || !self.outside.is_empty()
    }
}

pub fn judge(registration: &Registration, asked: &ScopeSet, registries: &Registries) -> Judged {
    let narrowed = narrow(asked, &registries.allowed());
    let published = registries.published();
    let mut judged = Judged {
        unknown: narrowed.dropped,
        ..Judged::default()
    };
    for literal in narrowed.kept.literals() {
        if literal == OFFLINE_ACCESS {
            if registration.can_refresh() {
                judged.kept.insert(literal);
            } else {
                judged.outside.push(literal.clone());
            }
        } else if covers(&registration.scope, literal) {
            judged.kept.insert(literal);
        } else if published.contains(literal) {
            judged.kept.insert(literal);
            judged.widened.insert(literal);
        } else {
            judged.outside.push(literal.clone());
        }
    }
    judged
}

/// So a type registered a moment ago counts.
pub(super) fn registries_in(
    unit: &Unit<'_, '_>,
    cache: &arc_swap::ArcSwap<catalog::Catalog>,
) -> Result<Registries> {
    Ok(Registries::of(&*catalog::current(
        cache,
        unit.tx(),
        Snapshot::Pending,
    )?))
}

pub(super) fn catch_up(
    unit: &Unit<'_, '_>,
    client: &Client,
    added: &ScopeSet,
    surface: &str,
) -> Result<()> {
    if added.is_empty() {
        return Ok(());
    }
    let mut ceiling = client.registration.scope.clone();
    for literal in added.literals() {
        ceiling.insert(literal);
    }
    store::set_client_scopes(unit.tx(), &client.id, &ceiling)?;
    unit.audit_also(
        "auth.client.scopes_widened",
        "oauth_client",
        &client.id,
        Some(json!({
            "client_id": client.id,
            "surface": surface,
            "added_scopes": added.literals(),
            "ceiling_size": ceiling.literals().len(),
        })),
    )
}

pub(super) fn ceiling_lacks(
    client: &Client,
    approved: &ScopeSet,
    registries: &Registries,
) -> Result<ScopeSet> {
    let published = registries.published();
    let mut lacking = ScopeSet::default();
    for literal in approved.literals() {
        if literal == OFFLINE_ACCESS || covers(&client.registration.scope, literal) {
            continue;
        }
        if !published.contains(literal) {
            return Err(Refusal::validation(format!(
                "This app cannot be approved for {literal}."
            )));
        }
        lacking.insert(literal);
    }
    Ok(lacking)
}

/// Whether the `cors_origins` setting or a standing consent names `origin`.
pub async fn page_approved(app: &App, origin: &str) -> Result<bool> {
    let origin = origin.to_string();
    if configured_origins(app).contains(&origin) {
        return Ok(true);
    }
    app.db
        .read(move |tx| store::origin_approved(tx, &origin))
        .await
}

pub(super) fn destinations_digest(app: &App, client: &Client) -> Result<String> {
    digest_of(
        &app.settings.start.key_salt,
        &client.registration.redirect_uris.join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::super::client::{AuthMethod, GrantType, ResponseType};
    use std::net::IpAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Barrier, mpsc};
    use std::time::Duration;

    use tempfile::TempDir;
    use tokio::sync::{mpsc as tokio_mpsc, oneshot};

    use super::super::redirect::AppKind;
    use super::*;
    use crate::app::clock::Stamp;
    use crate::settings::{Environment, Settings};

    type FetchResult = std::result::Result<Vec<u8>, Failure>;

    fn registration(scope: &str, grants: Vec<GrantType>) -> Registration {
        Registration {
            application_type: AppKind::Native,
            token_endpoint_auth_method: AuthMethod::None,
            grant_types: grants,
            response_types: vec![ResponseType::Code],
            redirect_uris: Vec::new(),
            scope: ScopeSet::parse(scope),
            client_name: None,
            client_uri: None,
            logo_uri: None,
            tos_uri: None,
            policy_uri: None,
            contacts: Vec::new(),
            software_id: None,
            software_version: None,
        }
    }

    #[test]
    fn a_request_is_narrowed_to_the_ceiling_and_published_scopes_catch_up() {
        let registries = Registries::new(["core.note", "user.recipe"], []);
        let judged = judge(
            &registration("user.recipe:read", vec![GrantType::AuthorizationCode]),
            &ScopeSet::parse("user.recipe:read core.*:read user.recipe:write notes"),
            &registries,
        );
        assert_eq!(judged.unknown, ["notes"]);
        assert_eq!(judged.outside, ["user.recipe:write"]);
        assert_eq!(judged.widened, ScopeSet::parse("core.*:read"));
        assert_eq!(judged.kept, ScopeSet::parse("user.recipe:read core.*:read"));
    }

    #[test]
    fn offline_access_needs_a_client_that_can_refresh() {
        let registries = Registries::new(["core.note"], []);
        let asked = ScopeSet::parse("offline_access core.*:read");
        let judged = judge(
            &registration("*:read", vec![GrantType::DeviceCode]),
            &asked,
            &registries,
        );
        assert_eq!(judged.outside, ["offline_access"]);
        let can = judge(
            &registration("*:read", vec![GrantType::RefreshToken]),
            &asked,
            &registries,
        );
        assert!(can.kept.contains("offline_access"));
    }

    #[test]
    fn a_ceiling_does_not_lack_what_it_covers() {
        let registries = Registries::new(["core.note", "user.recipe"], []);
        let client = Client {
            id: "c".to_string(),
            registration: registration("*:read", vec![GrantType::AuthorizationCode]),
            created_at: Stamp::from_ms(0).unwrap(),
        };
        assert!(
            ceiling_lacks(&client, &ScopeSet::parse("user.recipe:read"), &registries)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            ceiling_lacks(&client, &ScopeSet::parse("core.*:write"), &registries).unwrap(),
            ScopeSet::parse("core.*:write")
        );
        assert!(
            ceiling_lacks(&client, &ScopeSet::parse("user.recipe:write"), &registries).is_err()
        );
    }

    const OWN: &str = "https://own.example";

    async fn started() -> (TempDir, Arc<App>) {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_SIGN_IN_ADDRESS", OWN),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        (dir, App::start(settings).await.unwrap())
    }

    fn visit() -> Visit {
        Visit {
            peer: Some(IpAddr::from([203, 0, 113, 7])),
            address: Some(IpAddr::from([203, 0, 113, 7])),
            user_agent: None,
        }
    }

    fn id_at(number: usize) -> String {
        format!("https://app.example/clients/{number}")
    }

    fn document(id: &str) -> Vec<u8> {
        json!({
            "client_id": id,
            "client_name": "An app",
            "redirect_uris": ["http://127.0.0.1/callback"],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": "core.note:read",
        })
        .to_string()
        .into_bytes()
    }

    fn failing_as(failure: Failure) -> impl FnOnce(&str) -> FetchResult + Send + 'static {
        move |_| Err(failure)
    }

    fn answering(id: &str) -> impl FnOnce(&str) -> FetchResult + Send + 'static + use<> {
        let body = document(id);
        move |_| Ok(body)
    }

    fn error_of(answer: Answered<Client>) -> &'static str {
        answer.unwrap_err().error
    }

    async fn refreshed(app: &Arc<App>, id: &str, uris: &[&str]) -> Client {
        let body = json!({
            "client_id": id,
            "client_name": "A page",
            "application_type": "web",
            "redirect_uris": uris,
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": "core.note:read",
        })
        .to_string()
        .into_bytes();
        app.clock
            .advance(2 * DOCUMENT_FRESH_MS.unsigned_abs())
            .unwrap();
        resolve_by(app, id, &visit(), move |_| Ok(body))
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn a_refreshed_document_narrows_an_approval_and_never_adds_to_it() {
        let (_dir, app) = started().await;
        let id = id_at(1);
        let one = "https://one.example/callback";
        let two = "https://two.example/callback";
        let three = "https://three.example/callback";
        let client = refreshed(&app, &id, &[one, two]).await;
        app.db
            .write(Write::own(), move |tx| {
                tx.execute(
                    "INSERT INTO owner (id, name, email, password, created_at, updated_at) \
                     VALUES ('u', 'u', 'u@example.test', 'x', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO oauth_consents \
                     (client_id, owner_id, grant_id, scopes, created_at, updated_at) \
                     VALUES (?1, 'u', 'g', '[]', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')",
                    [&client.id],
                )?;
                store::approve_destinations(tx, &client, "u")
            })
            .await
            .unwrap();
        let held = async || {
            let id = id.clone();
            let mut uris = app
                .db
                .read(move |tx| store::approved_destinations(tx, &id, "u"))
                .await
                .unwrap();
            uris.sort();
            uris
        };

        refreshed(&app, &id, &[one, two, three]).await;
        assert_eq!(held().await, [one, two]);
        assert!(!page_approved(&app, "https://three.example").await.unwrap());

        refreshed(&app, &id, &[two, three]).await;
        assert_eq!(held().await, [two]);
        assert!(!page_approved(&app, "https://one.example").await.unwrap());
        assert!(page_approved(&app, "https://two.example").await.unwrap());
    }

    #[tokio::test]
    async fn a_fetch_leaves_the_async_threads_and_every_write_free() {
        let (_dir, app) = started().await;
        let id = id_at(1);
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let body = document(&id);
        let parked = move |_: &str| {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(body)
        };
        let meanwhile = async {
            started_rx.await.unwrap();
            app.db.write(Write::own(), |_| Ok(())).await.unwrap();
            release_tx.send(()).unwrap();
        };
        let seen = visit();
        let (answer, ()) = tokio::join!(resolve_by(&app, &id, &seen, parked), meanwhile);
        assert_eq!(answer.unwrap().unwrap().id, id);
    }

    #[tokio::test]
    async fn fetches_are_limited_by_address_and_nothing_past_it_is_fetched() {
        let (_dir, app) = started().await;
        let fetches = Arc::new(AtomicUsize::new(0));
        let counted = |id: &str| {
            let fetches = fetches.clone();
            let body = document(id);
            move |_: &str| {
                fetches.fetch_add(1, Ordering::SeqCst);
                Ok(body)
            }
        };
        for number in 0..10 {
            let id = id_at(number);
            let answer = resolve_by(&app, &id, &visit(), counted(&id)).await;
            assert!(answer.unwrap().is_ok());
        }
        let id = id_at(10);
        let answer = resolve_by(&app, &id, &visit(), counted(&id)).await;
        assert_eq!(error_of(answer.unwrap()), "temporarily_unavailable");
        assert_eq!(fetches.load(Ordering::SeqCst), 10);
    }

    #[tokio::test]
    async fn no_more_fetches_run_at_once_than_the_cap() {
        let (_dir, app) = started().await;
        let (started_tx, mut started_rx) = tokio_mpsc::unbounded_channel();
        let release = Arc::new(Barrier::new(MOST_FETCHES_AT_ONCE + 1));
        let mut parked = Vec::new();
        for number in 0..MOST_FETCHES_AT_ONCE {
            let (app, id) = (app.clone(), id_at(number));
            let (started_tx, release) = (started_tx.clone(), release.clone());
            let body = document(&id);
            parked.push(tokio::spawn(async move {
                let fetch = move |_: &str| {
                    started_tx.send(()).unwrap();
                    release.wait();
                    Ok(body)
                };
                resolve_by(&app, &id, &visit(), fetch).await
            }));
        }
        for _ in 0..MOST_FETCHES_AT_ONCE {
            started_rx.recv().await.unwrap();
        }
        let id = id_at(MOST_FETCHES_AT_ONCE);
        let over = resolve_by(&app, &id, &visit(), |_: &str| {
            panic!("a fetch ran past the cap")
        })
        .await;
        assert_eq!(error_of(over.unwrap()), "temporarily_unavailable");
        release.wait();
        for task in parked {
            assert!(task.await.unwrap().unwrap().is_ok());
        }
    }

    #[tokio::test]
    async fn a_client_id_on_this_instance_is_never_fetched() {
        let (_dir, app) = started().await;
        let own = format!("{OWN}/clients/1");
        let answer = resolve_by(&app, &own, &visit(), |_: &str| {
            panic!("a fetch of this instance ran")
        })
        .await;
        assert_eq!(error_of(answer.unwrap()), "invalid_client");
        let id = id_at(1);
        let elsewhere = resolve_by(&app, &id, &visit(), answering(&id)).await;
        assert_eq!(elsewhere.unwrap().unwrap().id, id);
    }

    #[tokio::test]
    async fn a_stored_client_works_through_an_outage_and_a_new_one_waits() {
        let (_dir, app) = started().await;
        let id = id_at(1);
        let unavailable = || failing_as(Failure::Unavailable("down"));
        let unknown = resolve_by(&app, &id, &visit(), unavailable()).await;
        assert_eq!(error_of(unknown.unwrap()), "temporarily_unavailable");

        resolve_by(&app, &id, &visit(), answering(&id))
            .await
            .unwrap()
            .unwrap();
        let fresh = resolve_by(&app, &id, &visit(), |_: &str| {
            panic!("a fresh copy was fetched again")
        })
        .await;
        assert!(fresh.unwrap().is_ok());

        app.clock.advance(2 * 3_600_000).unwrap();
        let stale = resolve_by(&app, &id, &visit(), unavailable()).await;
        assert_eq!(stale.unwrap().unwrap().id, id);
    }

    #[tokio::test]
    async fn an_error_is_never_kept() {
        let (_dir, app) = started().await;
        let id = id_at(1);
        for failure in [Failure::Unavailable("down"), Failure::Refused("no")] {
            let failed = resolve_by(&app, &id, &visit(), failing_as(failure)).await;
            assert!(failed.unwrap().is_err());
        }
        let bad = resolve_by(&app, &id, &visit(), |_: &str| Ok(b"not json".to_vec())).await;
        assert_eq!(error_of(bad.unwrap()), "invalid_client");
        let answer = resolve_by(&app, &id, &visit(), answering(&id)).await;
        assert_eq!(answer.unwrap().unwrap().id, id);
    }
}
