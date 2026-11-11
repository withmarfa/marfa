use std::sync::Arc;

use rusqlite::{Connection, Transaction};
use serde_json::json;

use super::client::GrantType;
use super::clients::{
    self, ceiling_lacks, destinations_digest, email_write_refused, judge, registries_in,
};
use super::grant::{self, CONSENT_SOURCE, GRANT_CREATED, GRANT_WRITE};
use super::metadata_document;
use super::offer::{self, Decision, Offer, Post, Request};
use super::pkce;
use super::redirect::{Destination, is_registered};
use super::reprompt;
use super::resource::{self, at_authorize};
use super::scope::{Registries, ScopeSet, first_uncovered, narrow, needs_recent_sign_in};
use super::signed_link::{self, Refused, Verified, has_repeat};
use super::store::{self, Client, Code, Consent};
use super::tokens::new_authorization_code;
use super::{Answered, CODE_SECONDS, MS_PER_SECOND, Problem, issuer};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::auth::Visit;
use crate::app::auth::return_to::kept;
use crate::app::catalog::{self, Snapshot};
use crate::app::keys::digest_of;
use crate::app::refusal::{Code as RefusalCode, Refusal, Result};
use crate::app::unit::Unit;
use crate::db::Write;

const CODE_WRITE: &str = "auth.code.issued";
const CONSENT_PATH: &str = "/auth/authorize";
const REQUEST_PATH: &str = "/auth/oauth2/authorize";
const NO_DESTINATION: &str = "/auth/error?error=invalid_redirect";
const NO_CLIENT: &str = "/auth/error?error=invalid_client";

/// `path` is read by the rule every `return_to` is, since a link's own is outside its signature.
pub fn sign_in_then(app: &App, path: &str) -> String {
    let origin = app.addresses().sign_in().origin().to_string();
    let back = kept(path, &origin);
    let encoded: String = url::form_urlencoded::byte_serialize(back.as_bytes()).collect();
    format!("/auth/sign-in?return_to={encoded}")
}

/// `return_to` goes first, so one riding in `link` is never the one read.
fn sign_in_for(app: &App, link: &str, path: &str) -> String {
    format!("{}&{link}", sign_in_then(app, path))
}

struct Asked {
    client_id: String,
    destination: Destination,
    state: Option<String>,
    scope: ScopeSet,
    challenge: String,
    resources: Vec<String>,
    prompt: Option<String>,
    issuer: String,
}

impl Asked {
    /// To the app only if the person's consent to it stands, otherwise to a page that names nothing
    /// of the request.
    fn refused(&self, standing: bool, problem: &Problem) -> String {
        if !standing {
            return format!("/auth/error?error={}", problem.error);
        }
        to_app(
            &self.destination,
            self.state.as_deref(),
            &[
                ("error", problem.error),
                ("error_description", &problem.description),
            ],
            &self.issuer,
        )
    }

    /// Only what was read and checked, never the query as it came.
    fn link_params(&self, scope: &ScopeSet) -> Vec<(String, String)> {
        let mut params: Vec<(String, String)> = [
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", self.destination.as_str()),
            ("response_type", "code"),
            ("code_challenge", self.challenge.as_str()),
            ("code_challenge_method", pkce::METHOD),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        params.push(("scope".to_string(), scope.to_text()));
        if let Some(state) = &self.state {
            params.push(("state".to_string(), state.clone()));
        }
        for value in &self.resources {
            params.push(("resource".to_string(), value.clone()));
        }
        params
    }
}

fn to_app(
    destination: &Destination,
    state: Option<&str>,
    pairs: &[(&str, &str)],
    issuer: &str,
) -> String {
    let mut all = pairs.to_vec();
    if let Some(state) = state {
        all.push(("state", state));
    }
    destination.with(&all, issuer)
}

fn only<'p>(pairs: &'p [(String, String)], name: &str) -> Option<&'p str> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

pub async fn begin(
    app: &Arc<App>,
    query: &str,
    owner: Option<Caller>,
    visit: &Visit,
) -> Result<Answered<String>> {
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    if has_repeat(&pairs) {
        return Ok(Err(Problem::new(
            "invalid_request",
            "A parameter is repeated.",
        )));
    }
    let Some(client_id) = only(&pairs, "client_id") else {
        return Ok(Err(Problem::new("invalid_request", "Name a client_id.")));
    };
    let client = match clients::resolve(app, client_id, visit).await? {
        Ok(client) => client,
        Err(_) if !metadata_document::is_url(client_id) => return Ok(Ok(NO_CLIENT.to_string())),
        Err(problem) => return Ok(Err(problem)),
    };
    let origin = app.addresses().sign_in().origin().to_string();
    let values: Vec<String> = pairs
        .iter()
        .filter(|(key, _)| key == "resource")
        .map(|(_, value)| value.clone())
        .collect();
    let resources = at_authorize(&origin, &values);
    let requested = only(&pairs, "redirect_uri").unwrap_or_default();
    let Some(destination) = Destination::of(&client.registration.redirect_uris, requested) else {
        return Ok(match resources {
            Err(_) => Err(no_such_resource()),
            Ok(_) => Ok(NO_DESTINATION.to_string()),
        });
    };
    let named = ScopeSet::parse(only(&pairs, "scope").unwrap_or_default());
    if named.writes_email() {
        return Ok(Err(email_write_refused()));
    }
    let mut asked = Asked {
        client_id: client.id.clone(),
        destination,
        state: only(&pairs, "state").map(str::to_string),
        scope: if named.is_empty() {
            client.registration.scope.clone()
        } else {
            named
        },
        challenge: only(&pairs, "code_challenge")
            .unwrap_or_default()
            .to_string(),
        resources: Vec::new(),
        prompt: only(&pairs, "prompt").map(str::to_string),
        issuer: issuer(app),
    };
    let refusal = match resources {
        Ok(resources) => {
            asked.resources = resources;
            refused_shape(&asked, &client, &pairs)
        }
        Err(resource::Refused::NotThisServer | resource::Refused::MoreThanOne) => {
            Some(no_such_resource())
        }
    };
    if let Some(problem) = refusal {
        let standing = stands_for(app, owner.as_ref(), &asked).await?;
        return Ok(Ok(asked.refused(standing, &problem)));
    }
    if reprompt::asks_login(asked.prompt.as_deref()) {
        let session = owner.as_ref().and_then(Caller::session);
        if !reprompt::signed_in_since(app, query, session) {
            if !grantable(app, &client, &asked) {
                let standing = stands_for(app, owner.as_ref(), &asked).await?;
                return Ok(Ok(asked.refused(standing, &nothing_grantable())));
            }
            let params = asked.link_params(&asked.scope);
            let signed = reprompt::signed_request(app, params, asked.prompt.as_deref(), session)?;
            let back = format!("{REQUEST_PATH}?{signed}");
            return Ok(Ok(sign_in_for(app, &signed, &back)));
        }
        asked.prompt = reprompt::without_login(asked.prompt.as_deref());
    }
    let Some(owner) = owner else {
        return signed_out(app, &client, &asked, query).map(Ok);
    };
    answer_signed_in(app, &owner, asked).await.map(Ok)
}

/// With nobody signed in there is no consent to read, so a refusal stays here.
fn signed_out(app: &App, client: &Client, asked: &Asked, query: &str) -> Result<String> {
    if asked.prompt.as_deref() == Some("none") {
        return Ok(asked.refused(
            false,
            &Problem::new("login_required", "Nobody is signed in."),
        ));
    }
    if !grantable(app, client, asked) {
        return Ok(asked.refused(false, &nothing_grantable()));
    }
    let exp = app.clock.now_ms() / MS_PER_SECOND + CODE_SECONDS;
    let params = asked.link_params(&asked.scope);
    let link = signed_link::sign(&params, exp, &app.settings.start.auth_secret)?;
    Ok(sign_in_for(app, &link, &format!("{REQUEST_PATH}?{query}")))
}

fn grantable(app: &App, client: &Client, asked: &Asked) -> bool {
    let registries = Registries::of(&app.catalog_handle().load());
    !judge(&client.registration, &asked.scope, &registries)
        .kept
        .is_empty()
}

fn standing_consent(
    tx: &Connection,
    client_id: &str,
    owner_id: &str,
    destination: &str,
) -> Result<Option<Consent>> {
    let approved = store::approved_destinations(tx, client_id, owner_id)?;
    Ok(store::consent(tx, client_id, owner_id)?
        .filter(Consent::stands)
        .filter(|_| is_registered(&approved, destination)))
}

async fn stands_for(app: &App, owner: Option<&Caller>, asked: &Asked) -> Result<bool> {
    let Some(session) = owner.and_then(Caller::session) else {
        return Ok(false);
    };
    let owner_id = session.owner_id.clone();
    let client_id = asked.client_id.clone();
    let destination = asked.destination.as_str().to_string();
    let read = move |tx: &Transaction<'_>| {
        standing_consent(tx, &client_id, &owner_id, &destination).map(|found| found.is_some())
    };
    app.db.read(read).await
}

fn no_such_resource() -> Problem {
    Problem::new("invalid_target", "This resource is not served here.")
}

fn nothing_grantable() -> Problem {
    Problem::new("invalid_scope", "No scope named can be granted.")
}

fn refused_shape(asked: &Asked, client: &Client, pairs: &[(String, String)]) -> Option<Problem> {
    if only(pairs, "response_type") != Some("code") {
        return Some(Problem::new(
            "unsupported_response_type",
            "Only the response type code is served.",
        ));
    }
    if !client
        .registration
        .names_grant(GrantType::AuthorizationCode)
    {
        return Some(Problem::new(
            "unauthorized_client",
            "This client is not registered for the authorization code grant.",
        ));
    }
    let shaped = pkce::is_challenge(&asked.challenge)
        && pkce::takes_method(only(pairs, "code_challenge_method"));
    (!shaped).then(|| Problem::new("invalid_request", "A PKCE S256 challenge is required."))
}

async fn answer_signed_in(app: &Arc<App>, owner: &Caller, asked: Asked) -> Result<String> {
    let cache = app.catalog_handle();
    let shared = app.clone();
    app.write(owner, CODE_WRITE, move |unit| {
        let Some(client) = store::client(unit.tx(), &asked.client_id)? else {
            let gone = Problem::new("invalid_client", "This client is gone.");
            return Ok(asked.refused(false, &gone));
        };
        let Some(destination) = Destination::of(
            &client.registration.redirect_uris,
            asked.destination.as_str(),
        ) else {
            return Ok(NO_DESTINATION.to_string());
        };
        let owner_id = user_of(unit)?;
        let consent = standing_consent(unit.tx(), &client.id, &owner_id, destination.as_str())?;
        let stands = consent.is_some();
        let registries = registries_in(unit, &cache)?;
        let judged = judge(&client.registration, &asked.scope, &registries);
        if judged.narrowed() {
            unit.audit_also(
                "auth.scopes.narrowed",
                "oauth_client",
                &client.id,
                Some(json!({
                    "client_id": client.id,
                    "requested_scopes": asked.scope.literals(),
                    "granted_scopes": judged.kept.literals(),
                    "dropped_unknown_to_server": judged.unknown,
                    "dropped_outside_client_ceiling": judged.outside,
                })),
            )?;
        }
        if judged.kept.is_empty() {
            return Ok(asked.refused(stands, &nothing_grantable()));
        }
        clients::catch_up(unit, &client, &judged.widened, "authorize")?;
        let covering =
            consent.filter(|consent| first_uncovered(&consent.scopes, &judged.kept).is_none());
        let prompt = asked.prompt.as_deref();
        match (covering, prompt) {
            (None, Some("none")) => Ok(asked.refused(
                stands,
                &Problem::new("consent_required", "This app needs a person's consent."),
            )),
            (Some(consent), prompt) if prompt != Some("consent") => {
                unit.audit_also(
                    "auth.grant.reused",
                    "oauth_grant",
                    &client.id,
                    Some(json!({
                        "client_id": client.id,
                        "owner_id": owner_id,
                        "scopes": judged.kept.literals(),
                        "grant_item_id": consent.grant_id,
                    })),
                )?;
                let ticket = Ticket {
                    client_id: &client.id,
                    grant_id: &consent.grant_id,
                    destination: &destination,
                    state: asked.state.as_deref(),
                    scopes: &judged.kept,
                    challenge: &asked.challenge,
                    resources: &asked.resources,
                    issuer: &asked.issuer,
                };
                issue_code(&shared, unit, ticket)
            }
            _ => {
                let exp = unit.instant.ms() / MS_PER_SECOND + CODE_SECONDS;
                let listed = destinations_digest(&shared, &client)?;
                let mut params = asked.link_params(&judged.kept);
                params.push(("destinations".to_string(), listed));
                let query = signed_link::sign(&params, exp, &shared.settings.start.auth_secret)?;
                Ok(format!("{CONSENT_PATH}?{query}"))
            }
        }
    })
    .await
}

fn user_of(unit: &Unit<'_, '_>) -> Result<String> {
    unit.caller
        .session()
        .map(|session| session.owner_id.clone())
        .ok_or_else(|| Refusal::internal("an approval has no browser session"))
}

struct Ticket<'t> {
    client_id: &'t str,
    grant_id: &'t str,
    destination: &'t Destination,
    state: Option<&'t str>,
    scopes: &'t ScopeSet,
    challenge: &'t str,
    resources: &'t [String],
    issuer: &'t str,
}

fn issue_code(app: &App, unit: &Unit<'_, '_>, ticket: Ticket<'_>) -> Result<String> {
    let session = unit
        .caller
        .session()
        .ok_or_else(|| Refusal::internal("an approval has no browser session"))?;
    let code = new_authorization_code()?;
    store::insert_code(
        unit.tx(),
        &Code {
            digest: digest_of(&app.settings.start.key_salt, &code)?,
            client_id: ticket.client_id.to_string(),
            owner_id: session.owner_id.clone(),
            session_id: session.id.clone(),
            grant_id: ticket.grant_id.to_string(),
            redirect_uri: ticket.destination.as_str().to_string(),
            scopes: ticket.scopes.clone(),
            challenge: ticket.challenge.to_string(),
            resources: ticket.resources.to_vec(),
            expires_at: unit.instant.plus_ms(CODE_SECONDS * MS_PER_SECOND)?,
            spent_at: None,
            chain_id: None,
        },
    )?;
    unit.audit_also(
        CODE_WRITE,
        "oauth_client",
        ticket.client_id,
        Some(json!({ "client_id": ticket.client_id, "owner_id": session.owner_id })),
    )?;
    Ok(to_app(
        ticket.destination,
        ticket.state,
        &[("code", &code)],
        ticket.issuer,
    ))
}

struct Linked {
    client_id: String,
    redirect_uri: String,
    scope: ScopeSet,
    destinations: Option<String>,
    state: Option<String>,
    challenge: String,
    resources: Vec<String>,
}

impl Linked {
    fn of(verified: &Verified) -> Option<Linked> {
        Some(Linked {
            client_id: verified.get("client_id")?.to_string(),
            redirect_uri: verified.get("redirect_uri")?.to_string(),
            scope: ScopeSet::parse(verified.get("scope").unwrap_or_default()),
            destinations: verified.get("destinations").map(str::to_string),
            state: verified.get("state").map(str::to_string),
            challenge: verified.get("code_challenge")?.to_string(),
            resources: verified.values("resource").map(str::to_string).collect(),
        })
    }
}

pub async fn app_named(app: &App, link: &Verified) -> Result<Option<String>> {
    let Some(client_id) = link.get("client_id").map(str::to_string) else {
        return Ok(None);
    };
    app.db
        .read(move |tx| Ok(store::client(tx, &client_id)?.map(|client| client.name())))
        .await
}

#[derive(Clone, Debug)]
pub enum Screen {
    Unverified,
    Expired,
    SignIn(String),
    ClientGone,
    Offered(Box<Offer>),
}

fn verified(app: &App, query: &str) -> std::result::Result<Linked, Screen> {
    let now = app.clock.now_ms() / MS_PER_SECOND;
    match signed_link::verify(query, now, &app.settings.start.auth_secret) {
        Ok(verified) => Linked::of(&verified).ok_or(Screen::Unverified),
        Err(Refused::Expired) => Err(Screen::Expired),
        Err(Refused::Unverified) => Err(Screen::Unverified),
    }
}

pub async fn screen(app: &Arc<App>, query: &str, owner: Option<&Caller>) -> Result<Screen> {
    let linked = match verified(app, query) {
        Ok(linked) => linked,
        Err(screen) => return Ok(screen),
    };
    let Some(owner_id) = owner
        .and_then(Caller::session)
        .map(|session| session.owner_id.clone())
    else {
        let back = format!("{CONSENT_PATH}?{query}");
        return Ok(Screen::SignIn(sign_in_for(app, query, &back)));
    };
    let cache = app.catalog_handle();
    let now = app.clock.instant();
    app.db
        .write(Write::own(), move |tx| {
            let Some(client) = store::client(tx, &linked.client_id)? else {
                return Ok(Screen::ClientGone);
            };
            store::note_offered(tx, &client.id, now)?;
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            let registries = super::scope::Registries::of(&catalog);
            let named = narrow(&linked.scope, &registries.allowed()).kept;
            let held = store::held_scopes(tx, &client.id, &owner_id)?;
            let choosable = registries.choosable_types();
            let request = Request {
                named: &named,
                held: &held,
                choosable: &choosable,
            };
            Ok(Screen::Offered(Box::new(
                offer::build(&client, &request).named(&catalog),
            )))
        })
        .await
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decided {
    Unverified,
    Expired,
    SignIn(String),
    Answered(String),
}

/// The whole approval is one write, so nothing of it stands unless all of it does.
pub async fn decide(
    app: &Arc<App>,
    owner: Option<&Caller>,
    link: &str,
    accept: bool,
    post: Post,
) -> Result<Decided> {
    let linked = match verified(app, link) {
        Ok(linked) => linked,
        Err(Screen::Expired) => return Ok(Decided::Expired),
        Err(_) => return Ok(Decided::Unverified),
    };
    let Some(owner) = owner else {
        let back = format!("{CONSENT_PATH}?{link}");
        return Ok(Decided::SignIn(sign_in_for(app, link, &back)));
    };
    let cache = app.catalog_handle();
    let shared = app.clone();
    app.write(owner, GRANT_WRITE, move |unit| {
        let client = store::client(unit.tx(), &linked.client_id)?
            .ok_or_else(|| Refusal::new(RefusalCode::NotFound, "This app is gone."))?;
        let destination = Destination::of(&client.registration.redirect_uris, &linked.redirect_uri)
            .ok_or_else(|| Refusal::new(RefusalCode::NotFound, "This app is gone."))?;
        let issuer = issuer(&shared);
        let denied = || {
            to_app(
                &destination,
                linked.state.as_deref(),
                &[
                    ("error", "access_denied"),
                    ("error_description", "The person did not approve this app."),
                ],
                &issuer,
            )
        };
        if !accept {
            return Ok(Decided::Answered(denied()));
        }
        let registries = registries_in(unit, &cache)?;
        let named = narrow(&linked.scope, &registries.allowed()).kept;
        let owner_id = user_of(unit)?;
        let held = store::held_scopes(unit.tx(), &client.id, &owner_id)?;
        let choosable = registries.choosable_types();
        let request = Request {
            named: &named,
            held: &held,
            choosable: &choosable,
        };
        let approved = match offer::read_decision(&request, &post) {
            Decision::Approved(approved) => approved,
            Decision::Denied => return Ok(Decided::Answered(denied())),
            Decision::Beyond => {
                return Err(Refusal::validation(
                    "This post chooses what the request did not offer.",
                ));
            }
        };
        let listed = destinations_digest(&shared, &client)?;
        if linked.destinations.as_deref() != Some(listed.as_str()) {
            return Ok(Decided::Expired);
        }
        if needs_recent_sign_in(&approved, &held) {
            unit.caller.require_recent(&unit.at)?;
        }
        let lacking = ceiling_lacks(&client, &approved, &registries)?;
        clients::catch_up(unit, &client, &lacking, "authorize")?;
        let stood = grant::stand(unit, &cache, &client, &owner_id, &approved, CONSENT_SOURCE)?;
        unit.audit_also(
            GRANT_CREATED,
            "oauth_grant",
            &client.id,
            Some(json!({
                "client_id": client.id,
                "owner_id": owner_id,
                "scopes": approved.literals(),
                "resulting_scopes": stood.scopes.literals(),
                "grant_item_id": stood.grant_id,
            })),
        )?;
        issue_code(
            &shared,
            unit,
            Ticket {
                client_id: &client.id,
                grant_id: &stood.grant_id,
                destination: &destination,
                state: linked.state.as_deref(),
                scopes: &approved,
                challenge: &linked.challenge,
                resources: &linked.resources,
                issuer: &issuer,
            },
        )
        .map(Decided::Answered)
    })
    .await
}
