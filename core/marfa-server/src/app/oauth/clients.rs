//! Which client a request names, whether registered or published as a
//! metadata document, and what it may ask for.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::Semaphore;

use super::client::Registration;
use super::metadata_document::{self, Failure, Fetcher};
use super::redirect::web_origins;
use super::scope::{OFFLINE_ACCESS, Registries, ScopeSet, covers, narrow};
use super::store::{self, Client};
use super::{Answered, Problem};
use crate::app::App;
use crate::app::audit::{self, Entry};
use crate::app::auth::Visit;
use crate::app::auth::limits::{admit, document_lanes};
use crate::app::catalog::{self, Snapshot};
use crate::app::refusal::{Refusal, Result};
use crate::app::unit::Unit;
use crate::db::Write;

const MOST_FETCHES_AT_ONCE: usize = 4;
const DOCUMENT_FRESH_MS: i64 = 3_600_000;
pub(super) const CLIENT_CREATED: &str = "auth.oauthClient.create";

/// The fetches of metadata documents in flight.
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

fn no_such_client() -> Problem {
    Problem::new("invalid_client", "No client has this client_id.")
}

fn busy() -> Problem {
    Problem::new(
        "temporarily_unavailable",
        "The client's metadata document cannot be read just now.",
    )
}

/// The client `id` names, by a stored row or by its metadata document.
pub async fn resolve(app: &Arc<App>, id: &str, visit: &Visit) -> Result<Answered<Client>> {
    let fetcher = Fetcher::default();
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
    let now = app.clock.now_ms();
    if let (Some(client), true) = (&stored, fresh_until.is_some_and(|until| until > now)) {
        return Ok(Ok(client.clone()));
    }
    if is_own_origin(app, id) || metadata_document::check_url(id).is_err() {
        return Ok(Err(refused_document()));
    }
    let keep_or_busy = |stored: Option<Client>| Ok(stored.ok_or_else(busy));
    let lanes = document_lanes(visit.address);
    let wait = app
        .db
        .write(Write::own(), move |tx| admit(tx, now, &lanes))
        .await?;
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
    let allowed = Registries::of(&app.catalog_handle().load()).allowed();
    let Ok(registration) = metadata_document::parse_document(id, &body, &allowed) else {
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

/// Stores what a document said. A ceiling widened since it was read stays.
async fn keep_document(
    app: &Arc<App>,
    id: &str,
    mut registration: Registration,
    visit: &Visit,
) -> Result<Client> {
    let id = id.to_string();
    let ip = visit.client_ip();
    let now = app.clock.now_ms();
    let at = app.clock.stamp();
    app.db
        .write(Write::caller(CLIENT_CREATED), move |tx| {
            let before = store::client(tx, &id)?;
            if let Some(before) = &before {
                for literal in before.registration.scope.literals() {
                    registration.scope.insert(literal);
                }
            }
            store::put_client(tx, &id, &registration, now)?;
            store::note_document(tx, &id, now, now + DOCUMENT_FRESH_MS)?;
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

/// What a client's request comes to, against its ceiling.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Judged {
    pub kept: ScopeSet,
    /// Literals the instance cannot grant to anyone.
    pub unknown: Vec<String>,
    /// Literals the instance could grant but this client may not ask for.
    pub outside: Vec<String>,
    /// Kept literals the instance publishes that the ceiling lacks.
    pub widened: ScopeSet,
}

impl Judged {
    pub fn narrowed(&self) -> bool {
        !self.unknown.is_empty() || !self.outside.is_empty()
    }
}

/// Narrows `asked` to what `registration` may be granted.
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

/// The instance's registries as `unit` sees them, so a type registered a
/// moment ago counts.
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

/// `keys-and-oauth/catch-up-signed-in`: adds `added` to the client's ceiling.
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

/// The approved literals `client`'s ceiling lacks, each one the instance
/// publishes, or a refusal where one is neither.
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

/// `keys-and-oauth/page-origin-allowed`: whether a standing consent to a web
/// client names `origin`.
pub async fn page_approved(app: &App, origin: &str) -> Result<bool> {
    let origin = origin.to_string();
    app.db
        .read(move |tx| {
            Ok(store::consented_clients(tx)?.iter().any(|client| {
                let registration = &client.registration;
                web_origins(registration.application_type, &registration.redirect_uris)
                    .contains(&origin)
            }))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::super::client::{AuthMethod, GrantType, ResponseType};
    use super::super::redirect::AppKind;
    use super::*;

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
            &ScopeSet::parse("user.recipe:read core.*:read user.recipe:write openid"),
            &registries,
        );
        assert_eq!(judged.unknown, ["openid"]);
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
            created_at: 0,
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
}
