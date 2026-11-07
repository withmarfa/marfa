//! The authorization request, what its consent screen offers and what a
//! person's decision does.

use std::sync::Arc;

use serde_json::json;

use super::client::GrantType;
use super::clients::{self, ceiling_lacks, judge, registries_in};
use super::grant::{self, CONSENT_SOURCE, GRANT_CREATED, GRANT_WRITE};
use super::offer::{self, Decision, Offer, Post, Request};
use super::pkce;
use super::redirect::Destination;
use super::resource::{self, at_authorize};
use super::scope::{ScopeSet, first_uncovered, narrow, needs_recent_sign_in};
use super::signed_link::{self, Refused, Verified, has_repeat};
use super::store::{self, Client, Code, Consent, ms_of, scopes_text};
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

/// The action of a write that may hand a browser a code.
const CODE_WRITE: &str = "auth.verification.create";
const CONSENT_PATH: &str = "/auth/authorize";
const REQUEST_PATH: &str = "/auth/oauth2/authorize";

/// The way to `/auth/sign-in` that comes back to `path`. `path` is read by the
/// rule every `return_to` is, since a link's own is outside its signature.
pub fn sign_in_then(app: &App, path: &str) -> String {
    let origin = app.addresses().sign_in().origin().to_string();
    let back = kept(path, &origin);
    let encoded: String = url::form_urlencoded::byte_serialize(back.as_bytes()).collect();
    format!("/auth/sign-in?return_to={encoded}")
}

/// A request whose client and redirect URI have passed, so an answer may go
/// to the app.
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
    fn refused(&self, error: &str, description: &str) -> String {
        to_app(
            &self.destination,
            self.state.as_deref(),
            &[("error", error), ("error_description", description)],
            &self.issuer,
        )
    }

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
        params.push(("scope".to_string(), scopes_text(scope)));
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

/// Where an authorization request sends the browser, or the refusal it gets
/// when nothing it names can be trusted with one.
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
            Ok(_) => Ok("/auth/error?error=invalid_redirect".to_string()),
        });
    };
    let mut asked = Asked {
        client_id: client.id.clone(),
        destination,
        state: only(&pairs, "state").map(str::to_string),
        scope: ScopeSet::parse(only(&pairs, "scope").unwrap_or_default()),
        challenge: only(&pairs, "code_challenge")
            .unwrap_or_default()
            .to_string(),
        resources: Vec::new(),
        prompt: only(&pairs, "prompt").map(str::to_string),
        issuer: issuer(app),
    };
    asked.resources = match resources {
        Ok(resources) => resources,
        Err(resource::Refused::NotThisServer | resource::Refused::MoreThanOne) => {
            let problem = no_such_resource();
            return Ok(Ok(asked.refused(problem.error, &problem.description)));
        }
    };
    if let Some(location) = refused_shape(&asked, &client, &pairs) {
        return Ok(Ok(location));
    }
    let Some(owner) = owner else {
        return Ok(Ok(if asked.prompt.as_deref() == Some("none") {
            asked.refused("login_required", "Nobody is signed in.")
        } else {
            sign_in_then(app, &format!("{REQUEST_PATH}?{query}"))
        }));
    };
    answer_signed_in(app, &owner, asked).await.map(Ok)
}

fn no_such_resource() -> Problem {
    Problem::new("invalid_target", "This resource is not served here.")
}

fn refused_shape(asked: &Asked, client: &Client, pairs: &[(String, String)]) -> Option<String> {
    if only(pairs, "response_type") != Some("code") {
        return Some(asked.refused(
            "unsupported_response_type",
            "Only the response type code is served.",
        ));
    }
    if !client
        .registration
        .names_grant(GrantType::AuthorizationCode)
    {
        return Some(asked.refused(
            "unauthorized_client",
            "This client is not registered for the authorization code grant.",
        ));
    }
    let shaped = pkce::is_challenge(&asked.challenge)
        && pkce::takes_method(only(pairs, "code_challenge_method"));
    (!shaped).then(|| asked.refused("invalid_request", "A PKCE S256 challenge is required."))
}

async fn answer_signed_in(app: &Arc<App>, owner: &Caller, asked: Asked) -> Result<String> {
    let cache = app.catalog_handle();
    let shared = app.clone();
    app.write(owner, CODE_WRITE, move |unit| {
        let Some(client) = store::client(unit.tx(), &asked.client_id)? else {
            return Ok(asked.refused("invalid_client", "This client is gone."));
        };
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
            return Ok(asked.refused("invalid_scope", "No scope named can be granted."));
        }
        clients::catch_up(unit, &client, &judged.widened, "authorize")?;
        let user_id = user_of(unit)?;
        let standing = store::consent(unit.tx(), &client.id, &user_id)?
            .filter(Consent::stands)
            .filter(|consent| first_uncovered(&consent.scopes, &judged.kept).is_none());
        let prompt = asked.prompt.as_deref();
        match (standing, prompt) {
            (None, Some("none")) => {
                Ok(asked.refused("consent_required", "This app needs a person's consent."))
            }
            (Some(consent), prompt) if prompt != Some("consent") => {
                unit.audit_also(
                    "auth.grant.reused",
                    "oauth_grant",
                    &client.id,
                    Some(json!({
                        "client_id": client.id,
                        "user_id": user_id,
                        "scopes": judged.kept.literals(),
                        "grant_item_id": consent.grant_id,
                    })),
                )?;
                let ticket = Ticket {
                    client_id: &client.id,
                    grant_id: &consent.grant_id,
                    destination: &asked.destination,
                    state: asked.state.as_deref(),
                    scopes: &judged.kept,
                    challenge: &asked.challenge,
                    resources: &asked.resources,
                    issuer: &asked.issuer,
                };
                issue_code(&shared, unit, ticket)
            }
            _ => {
                let exp = ms_of(&unit.at)? / MS_PER_SECOND + CODE_SECONDS;
                let params = asked.link_params(&judged.kept);
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
        .map(|session| session.user_id.clone())
        .ok_or_else(|| Refusal::internal("an approval has no browser session"))
}

/// What a code carries.
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
            digest: digest_of(&app.settings.start.api_key_salt, &code)?,
            client_id: ticket.client_id.to_string(),
            user_id: session.user_id.clone(),
            session_id: session.id.clone(),
            grant_id: ticket.grant_id.to_string(),
            redirect_uri: ticket.destination.as_str().to_string(),
            scopes: ticket.scopes.clone(),
            challenge: ticket.challenge.to_string(),
            resources: ticket.resources.to_vec(),
            expires_at: ms_of(&unit.at)? + CODE_SECONDS * MS_PER_SECOND,
        },
    )?;
    unit.audit_also(
        CODE_WRITE,
        "oauth_client",
        ticket.client_id,
        Some(json!({ "client_id": ticket.client_id, "user_id": session.user_id })),
    )?;
    Ok(to_app(
        ticket.destination,
        ticket.state,
        &[("code", &code)],
        ticket.issuer,
    ))
}

/// A signed link, read back into what it asked.
struct Linked {
    client_id: String,
    redirect_uri: String,
    scope: ScopeSet,
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
            state: verified.get("state").map(str::to_string),
            challenge: verified.get("code_challenge")?.to_string(),
            resources: verified.values("resource").map(str::to_string).collect(),
        })
    }
}

/// What opening a consent link comes to.
#[derive(Clone, Debug)]
pub enum Screen {
    Unverified,
    Expired,
    /// The browser has nobody signed in, and this is the way there.
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

/// What the consent screen at `query` shows `owner`.
pub async fn screen(app: &Arc<App>, query: &str, owner: Option<&Caller>) -> Result<Screen> {
    let linked = match verified(app, query) {
        Ok(linked) => linked,
        Err(screen) => return Ok(screen),
    };
    let Some(user_id) = owner
        .and_then(Caller::session)
        .map(|session| session.user_id.clone())
    else {
        return Ok(Screen::SignIn(sign_in_then(
            app,
            &format!("{CONSENT_PATH}?{query}"),
        )));
    };
    let cache = app.catalog_handle();
    let now = app.clock.now_ms();
    app.db
        .write(Write::own(), move |tx| {
            let Some(client) = store::client(tx, &linked.client_id)? else {
                return Ok(Screen::ClientGone);
            };
            store::note_offered(tx, &client.id, now)?;
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            let registries = super::scope::Registries::of(&catalog);
            let named = narrow(&linked.scope, &registries.allowed()).kept;
            let held = store::held_scopes(tx, &client.id, &user_id)?;
            let choosable = registries.choosable_types();
            let request = Request {
                named: &named,
                held: &held,
                choosable: &choosable,
            };
            Ok(Screen::Offered(Box::new(offer::build(&client, &request))))
        })
        .await
}

/// What a post to the decision door does.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decided {
    Unverified,
    Expired,
    /// The browser has nobody signed in, and this is the way there.
    SignIn(String),
    /// Send the browser here: the answer to the app.
    Answered(String),
}

/// Answers the consent screen `link` showed. The whole of an approval is one
/// write, so nothing of it stands unless all of it does.
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
        return Ok(Decided::SignIn(sign_in_then(
            app,
            &format!("{CONSENT_PATH}?{link}"),
        )));
    };
    let cache = app.catalog_handle();
    let shared = app.clone();
    let answered = app
        .write(owner, GRANT_WRITE, move |unit| {
            let client = store::client(unit.tx(), &linked.client_id)?
                .ok_or_else(|| Refusal::new(RefusalCode::NotFound, "This app is gone."))?;
            let destination =
                Destination::of(&client.registration.redirect_uris, &linked.redirect_uri)
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
                return Ok(denied());
            }
            let registries = registries_in(unit, &cache)?;
            let named = narrow(&linked.scope, &registries.allowed()).kept;
            let user_id = user_of(unit)?;
            let held = store::held_scopes(unit.tx(), &client.id, &user_id)?;
            let choosable = registries.choosable_types();
            let request = Request {
                named: &named,
                held: &held,
                choosable: &choosable,
            };
            let approved = match offer::read_decision(&request, &post) {
                Decision::Approved(approved) => approved,
                Decision::Denied => return Ok(denied()),
                Decision::Beyond => {
                    return Err(Refusal::validation(
                        "This post chooses what the request did not offer.",
                    ));
                }
            };
            if needs_recent_sign_in(&approved, &held) {
                unit.caller.require_recent(&unit.at)?;
            }
            let lacking = ceiling_lacks(&client, &approved, &registries)?;
            clients::catch_up(unit, &client, &lacking, "authorize")?;
            let stood = grant::stand(unit, &cache, &client, &user_id, &approved, CONSENT_SOURCE)?;
            unit.audit_also(
                GRANT_CREATED,
                "oauth_grant",
                &client.id,
                Some(json!({
                    "client_id": client.id,
                    "user_id": user_id,
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
        })
        .await?;
    Ok(Decided::Answered(answered))
}
