//! `POST /auth/oauth2/token`, and the one check of a client it shares with
//! revocation. Each exchange is one write: the check and the spending of what
//! is exchanged commit together, so two uses at once cannot both win.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::client::{AuthMethod, GrantType};
use super::clients::email_write_refused;
use super::pkce;
use super::resource::{Refused, at_token};
use super::scope::{OFFLINE_ACCESS, ScopeSet, first_uncovered};
use super::signed_link::has_repeat;
use super::store::{self, AccessToken, Client, DeviceStatus, RefreshToken, ms_of};
use super::tokens::{new_access_token, new_refresh_token};
use super::{ACCESS_TOKEN_SECONDS, Answered, MS_PER_SECOND, Problem, REFRESH_TOKEN_SECONDS};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::audit::{self, Entry};
use crate::app::auth::Visit;
use crate::app::auth::session;
use crate::app::keys::digest_of;
use crate::app::refusal::Result;
use crate::app::unit::Unit;

const TOKEN_ISSUED: &str = "auth.token.issued";

/// A form as a token door read it.
#[derive(Clone, Debug, Default)]
pub struct Form {
    pub pairs: Vec<(String, String)>,
    /// The request carried an `Authorization` header.
    pub authorization: bool,
}

impl Form {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty())
    }

    fn resources(&self) -> Vec<String> {
        self.pairs
            .iter()
            .filter(|(key, _)| key == "resource")
            .map(|(_, value)| value.clone())
            .collect()
    }
}

fn invalid_grant(description: &str) -> Problem {
    Problem::new("invalid_grant", description)
}

/// The client a form speaks for, proved as its registration says it proves
/// itself. A public client proves nothing, so it may present no secret.
pub(super) async fn checked_client(app: &App, form: &Form) -> Result<Answered<Client>> {
    let Some(id) = form.get("client_id").map(str::to_string) else {
        return Ok(Err(Problem::new("invalid_request", "Name a client_id.")));
    };
    let unknown =
        || Problem::new("invalid_client", "No client has this client_id.").with_status(401);
    let Some(client) = app.db.read(move |tx| store::client(tx, &id)).await? else {
        return Ok(Err(unknown()));
    };
    match client.registration.token_endpoint_auth_method {
        AuthMethod::None if form.authorization || form.get("client_secret").is_some() => {
            Ok(Err(Problem::new(
                "invalid_client",
                "This client is public and presents no secret.",
            )
            .with_status(401)))
        }
        AuthMethod::None => Ok(Ok(client)),
    }
}

/// `keys-and-oauth/token-no-client`: a public client's proof is what its grant
/// presents, so a request lacking it is judged before its `client_id` is.
fn unproved(grant: GrantType, form: &Form) -> Option<Problem> {
    let (fields, description): (&[&str], _) = match grant {
        GrantType::AuthorizationCode => (
            &["code", "code_verifier", "redirect_uri"],
            "Name the code, its code_verifier and its redirect_uri.",
        ),
        GrantType::RefreshToken => (&["refresh_token"], "Name the refresh_token."),
        GrantType::DeviceCode => (&["device_code"], "Name the device_code."),
    };
    fields
        .iter()
        .any(|field| form.get(field).is_none())
        .then(|| Problem::new("invalid_request", description))
}

/// Answers a token request.
pub async fn exchange(
    app: &Arc<App>,
    form: Form,
    visit: &Visit,
) -> Result<Answered<Map<String, Value>>> {
    let Some(word) = form.get("grant_type") else {
        return Ok(Err(Problem::new("invalid_request", "Name a grant_type.")));
    };
    let Some(grant) = GrantType::from_word(word) else {
        return Ok(Err(Problem::new(
            "unsupported_grant_type",
            "This grant type is not served.",
        )));
    };
    if let Some(problem) = unproved(grant, &form) {
        return Ok(Err(problem));
    }
    let client = match checked_client(app, &form).await? {
        Ok(client) => client,
        Err(problem) => return Ok(Err(problem)),
    };
    let origin = app.addresses().sign_in().origin().to_string();
    let audience = match at_token(&origin, &form.resources()) {
        Ok(audience) => audience,
        Err(Refused::NotThisServer | Refused::MoreThanOne) => {
            return Ok(Err(Problem::new(
                "invalid_target",
                "This resource is not served here.",
            )));
        }
    };
    if has_repeat(&form.pairs) {
        return Ok(Err(Problem::new(
            "invalid_request",
            "A parameter is repeated.",
        )));
    }
    if !client.registration.names_grant(grant) {
        return Ok(Err(Problem::new(
            "unauthorized_client",
            "This client is not registered for this grant.",
        )));
    }
    if form
        .get("scope")
        .map(ScopeSet::parse)
        .is_some_and(|asked| asked.writes_email())
    {
        return Ok(Err(email_write_refused()));
    }
    let ip = visit.client_ip();
    match grant {
        GrantType::AuthorizationCode => by_code(app, client, form, audience, ip).await,
        GrantType::RefreshToken => by_refresh(app, client, form, audience, ip).await,
        GrantType::DeviceCode => by_device_code(app, client, form, audience, ip).await,
    }
}

/// What a set of tokens is for.
struct Issue<'i> {
    client: &'i Client,
    user_id: &'i str,
    chain_id: &'i str,
    scopes: &'i ScopeSet,
    /// What the refresh token keeps, which a narrower access token leaves
    /// whole.
    keeps: &'i ScopeSet,
    audience: Option<&'i str>,
    refresh: bool,
    ip: Option<&'i str>,
}

fn issue(app: &App, unit: &Unit<'_, '_>, issue: Issue<'_>) -> Result<Map<String, Value>> {
    let tx = unit.tx();
    let now = ms_of(&unit.at)?;
    let salt = &app.settings.start.api_key_salt;
    let access = new_access_token()?;
    store::insert_access_token(
        tx,
        &AccessToken {
            id: Uuid::now_v7().to_string(),
            digest: digest_of(salt, &access)?,
            client_id: issue.client.id.clone(),
            user_id: issue.user_id.to_string(),
            chain_id: issue.chain_id.to_string(),
            scopes: issue.scopes.clone(),
            audience: issue.audience.map(str::to_string),
            created_at: now,
            expires_at: now + ACCESS_TOKEN_SECONDS * MS_PER_SECOND,
        },
    )?;
    let mut answer = Map::new();
    answer.insert("access_token".to_string(), json!(access));
    answer.insert("token_type".to_string(), json!("Bearer"));
    answer.insert("expires_in".to_string(), json!(ACCESS_TOKEN_SECONDS));
    answer.insert("scope".to_string(), json!(issue.scopes.to_text()));
    if issue.refresh {
        let refresh = new_refresh_token()?;
        store::insert_refresh_token(
            tx,
            &RefreshToken {
                id: Uuid::now_v7().to_string(),
                digest: digest_of(salt, &refresh)?,
                client_id: issue.client.id.clone(),
                user_id: issue.user_id.to_string(),
                chain_id: issue.chain_id.to_string(),
                scopes: issue.keeps.clone(),
                audience: issue.audience.map(str::to_string),
                created_at: now,
                expires_at: now + REFRESH_TOKEN_SECONDS * MS_PER_SECOND,
                rotated_at: None,
                ended_at: None,
            },
        )?;
        answer.insert("refresh_token".to_string(), json!(refresh));
    }
    store::note_consent_used(tx, &issue.client.id, issue.user_id, now)?;
    audit::record_from(
        tx,
        &unit.at,
        None,
        issue.ip,
        Entry {
            action: TOKEN_ISSUED,
            resource_type: "oauth_client",
            resource_id: Some(&issue.client.id),
            details: Some(json!({
                "client_id": issue.client.id,
                "user_id": issue.user_id,
                "scopes": issue.scopes.literals(),
            })),
        },
    )?;
    Ok(answer)
}

fn takes_refresh(client: &Client, scopes: &ScopeSet) -> bool {
    scopes.contains(OFFLINE_ACCESS) && client.registration.can_refresh()
}

async fn by_code(
    app: &Arc<App>,
    client: Client,
    form: Form,
    audience: Option<String>,
    ip: Option<String>,
) -> Result<Answered<Map<String, Value>>> {
    let field = |name| form.get(name).unwrap_or_default().to_string();
    let (code, verifier, redirect_uri) =
        (field("code"), field("code_verifier"), field("redirect_uri"));
    let shared = app.clone();
    app.write(&Caller::Server, TOKEN_ISSUED, move |unit| {
        let tx = unit.tx();
        let now = ms_of(&unit.at)?;
        let digest = digest_of(&shared.settings.start.api_key_salt, &code)?;
        let spent = || invalid_grant("This code cannot be exchanged.");
        let Some(code) = store::code(tx, &digest)?.filter(|code| code.expires_at > now) else {
            return Ok(Err(spent()));
        };
        if code.spent_at.is_some() {
            if let Some(chain_id) = &code.chain_id {
                store::end_chain(tx, chain_id, now)?;
                store::name_code_chain(tx, &digest, None)?;
                audit::record_from(
                    tx,
                    &unit.at,
                    None,
                    ip.as_deref(),
                    Entry {
                        action: "auth.code.replayed",
                        resource_type: "oauth_grant",
                        resource_id: Some(&code.client_id),
                        details: Some(json!({
                            "client_id": code.client_id,
                            "user_id": code.user_id,
                        })),
                    },
                )?;
            }
            return Ok(Err(spent()));
        }
        store::spend_code(tx, &digest, now)?;
        if code.client_id != client.id
            || code.redirect_uri != redirect_uri
            || !pkce::proves(&verifier, &code.challenge)
        {
            return Ok(Err(spent()));
        }
        if let Some(asked) = &audience
            && !code.resources.is_empty()
            && !code.resources.contains(asked)
        {
            return Ok(Err(Problem::new(
                "invalid_target",
                "This resource was not authorized.",
            )));
        }
        if session::live_by_id(tx, &code.session_id, now / MS_PER_SECOND)?.is_none() {
            return Ok(Err(Problem::new(
                "invalid_request",
                "The browser session that approved this code has ended.",
            )));
        }
        let stands = store::consent(tx, &client.id, &code.user_id)?
            .is_some_and(|consent| consent.stands() && consent.grant_id == code.grant_id);
        if !stands {
            return Ok(Err(spent()));
        }
        let audience = audience.or_else(|| code.resources.first().cloned());
        let chain_id = Uuid::now_v7().to_string();
        store::name_code_chain(tx, &digest, Some(&chain_id))?;
        issue(
            &shared,
            unit,
            Issue {
                client: &client,
                user_id: &code.user_id,
                chain_id: &chain_id,
                scopes: &code.scopes,
                keeps: &code.scopes,
                audience: audience.as_deref(),
                refresh: takes_refresh(&client, &code.scopes),
                ip: ip.as_deref(),
            },
        )
        .map(Ok)
    })
    .await
}

async fn by_refresh(
    app: &Arc<App>,
    client: Client,
    form: Form,
    audience: Option<String>,
    ip: Option<String>,
) -> Result<Answered<Map<String, Value>>> {
    let token = form.get("refresh_token").unwrap_or_default().to_string();
    let asked = form.get("scope").map(ScopeSet::parse);
    let shared = app.clone();
    app.write(&Caller::Server, TOKEN_ISSUED, move |unit| {
        let tx = unit.tx();
        let now = ms_of(&unit.at)?;
        let digest = digest_of(&shared.settings.start.api_key_salt, &token)?;
        let dead = || invalid_grant("This refresh token cannot be used.");
        let Some(old) = store::refresh_token_by_digest(tx, &digest)?
            .filter(|old| old.client_id == client.id && old.ended_at.is_none())
        else {
            return Ok(Err(dead()));
        };
        if old.rotated_at.is_some() {
            store::end_chain(tx, &old.chain_id, now)?;
            audit::record_from(
                tx,
                &unit.at,
                None,
                ip.as_deref(),
                Entry {
                    action: "auth.refresh.replayed",
                    resource_type: "oauth_grant",
                    resource_id: Some(&client.id),
                    details: Some(json!({ "client_id": client.id, "user_id": old.user_id })),
                },
            )?;
            return Ok(Err(dead()));
        }
        let consent = store::consent(tx, &client.id, &old.user_id)?;
        let Some(consent) = consent.filter(|consent| consent.stands() && old.expires_at > now)
        else {
            return Ok(Err(dead()));
        };
        if first_uncovered(&consent.scopes, &old.scopes).is_some() {
            store::end_chain(tx, &old.chain_id, now)?;
            return Ok(Err(dead()));
        }
        if let Some(asked) = &asked
            && first_uncovered(&old.scopes, asked).is_some()
        {
            return Ok(Err(Problem::new(
                "invalid_scope",
                "A refresh cannot widen what was granted.",
            )));
        }
        store::rotate_refresh_token(tx, &old.id, now)?;
        let audience = audience.or_else(|| old.audience.clone());
        issue(
            &shared,
            unit,
            Issue {
                client: &client,
                user_id: &old.user_id,
                chain_id: &old.chain_id,
                scopes: asked.as_ref().unwrap_or(&old.scopes),
                keeps: &old.scopes,
                audience: audience.as_deref(),
                refresh: true,
                ip: ip.as_deref(),
            },
        )
        .map(Ok)
    })
    .await
}

async fn by_device_code(
    app: &Arc<App>,
    client: Client,
    form: Form,
    audience: Option<String>,
    ip: Option<String>,
) -> Result<Answered<Map<String, Value>>> {
    let code = form.get("device_code").unwrap_or_default().to_string();
    let shared = app.clone();
    app.write(&Caller::Server, TOKEN_ISSUED, move |unit| {
        let tx = unit.tx();
        let now = ms_of(&unit.at)?;
        let digest = digest_of(&shared.settings.start.api_key_salt, &code)?;
        let spent = || invalid_grant("This device code cannot be exchanged.");
        let Some(code) =
            store::device_code(tx, &digest)?.filter(|code| code.client_id == client.id)
        else {
            return Ok(Err(spent()));
        };
        if code.status == DeviceStatus::Spent {
            return Ok(Err(spent()));
        }
        if code.expires_at <= now {
            store::remove_device_code(tx, &digest)?;
            return Ok(Err(Problem::new(
                "expired_token",
                "This device code has expired.",
            )));
        }
        let waited = code
            .last_polled_at
            .is_none_or(|last| now >= last + code.interval_seconds * MS_PER_SECOND);
        store::note_device_poll(tx, &digest, now)?;
        if !waited {
            return Ok(Err(Problem::new("slow_down", "Poll less often.")));
        }
        match code.status {
            DeviceStatus::Denied => Ok(Err(Problem::new(
                "access_denied",
                "The person did not approve this app.",
            ))),
            DeviceStatus::Pending => Ok(Err(Problem::new(
                "authorization_pending",
                "The person has not answered yet.",
            ))),
            DeviceStatus::Spent => Ok(Err(spent())),
            DeviceStatus::Approved => {
                let Some(user_id) = code.user_id.clone() else {
                    return Ok(Err(spent()));
                };
                match store::consent(tx, &client.id, &user_id)? {
                    Some(consent) if consent.stands() => {}
                    _ => return Ok(Err(spent())),
                }
                store::spend_device_code(tx, &digest)?;
                issue(
                    &shared,
                    unit,
                    Issue {
                        client: &client,
                        user_id: &user_id,
                        chain_id: &Uuid::now_v7().to_string(),
                        scopes: &code.scopes,
                        keeps: &code.scopes,
                        audience: audience.as_deref(),
                        refresh: takes_refresh(&client, &code.scopes),
                        ip: ip.as_deref(),
                    },
                )
                .map(Ok)
            }
        }
    })
    .await
}
