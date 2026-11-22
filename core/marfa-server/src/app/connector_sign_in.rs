//! A plugin connector's sign-in with its provider, made in the owner's browser.

use std::io::Read;
use std::net::SocketAddr;
use std::time::Duration;

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use ureq::Agent;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;
use url::Url;

use super::App;
use super::access::{Caller, Permission};
use super::auth::limits::{connector_sign_in_lanes, hold_to};
use super::auth::return_to;
use super::clock::Stamp;
use super::connector_settings::{self, ForSignIn};
use super::connectors;
use super::faults::SignInProvider;
use super::oauth;
use super::outbound::{self, Asker, Pinned, Reach};
use super::refusal::{Code, Refusal, Result};
use super::unit::Unit;
use crate::settings::sealed::{Sealer, Secret};

pub const STARTED: &str = "connector.sign_in";
pub const SIGNED_IN: &str = "connector.signed_in";
pub const FAILED: &str = "connector.sign_in_failed";
const CLAIMED: &str = "connector.sign_in_claim";
const FINISHED: &str = "connector.sign_in_finish";
pub const CALLBACK_PATH: &str = "/connect/oauth/callback";

const LIFE_MS: i64 = 10 * 60 * 1000;
const EXCHANGE_BOUND: Duration = Duration::from_secs(15);
/// How long a sign-in stays pending after a callback claims it, for the token request to end.
const CLAIM_GRACE_MS: i64 = 60 * 1000;
const RETURN_TO_CAP: usize = 2048;
const STATE_CAP: usize = 512;
const ANSWER_CAP: u64 = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const RANDOM_BYTES: usize = 32;

/// The token errors RFC 6749 section 5.2 fixes.
const TOKEN_ERRORS: &[&str] = &[
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
];

/// The authorization errors RFC 6749 section 4.1.2.1 fixes.
const BROWSER_ERRORS: &[&str] = &[
    "invalid_request",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable",
];

/// Why a sign-in failed, as a word Marfa fixes. None carries text the provider wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    TokenError(&'static str),
    BrowserError(&'static str),
    ProviderError,
    NoCode,
    ChangedSinceStart,
    Timeout,
    Unreachable,
    Status(u16),
    NoRefreshToken,
    UnreadableAnswer,
}

fn fixed(words: &[&'static str], given: &str) -> Option<&'static str> {
    words.iter().find(|word| **word == given).copied()
}

impl Failure {
    pub fn word(&self) -> String {
        match self {
            Failure::TokenError(word) | Failure::BrowserError(word) => (*word).to_string(),
            Failure::ProviderError => "provider_error".into(),
            Failure::NoCode => "no_code".into(),
            Failure::ChangedSinceStart => "changed_since_start".into(),
            Failure::Timeout => "timeout".into(),
            Failure::Unreachable => "unreachable".into(),
            Failure::Status(status) => format!("status_{status}"),
            Failure::NoRefreshToken => "no_refresh_token".into(),
            Failure::UnreadableAnswer => "unreadable_answer".into(),
        }
    }

    /// A stored word, or `None` where it is no word this server records.
    fn read(word: &str) -> Option<Failure> {
        if let Some(status) = word.strip_prefix("status_") {
            return status
                .parse::<u16>()
                .ok()
                .filter(|number| number.to_string() == status)
                .map(Failure::Status);
        }
        let named = [
            Failure::ProviderError,
            Failure::NoCode,
            Failure::ChangedSinceStart,
            Failure::Timeout,
            Failure::Unreachable,
            Failure::NoRefreshToken,
            Failure::UnreadableAnswer,
        ];
        named
            .into_iter()
            .find(|failure| failure.word() == word)
            .or_else(|| fixed(TOKEN_ERRORS, word).map(Failure::TokenError))
            .or_else(|| fixed(BROWSER_ERRORS, word).map(Failure::BrowserError))
    }

    fn of_browser(error: &str) -> Failure {
        fixed(BROWSER_ERRORS, error).map_or(Failure::ProviderError, Failure::BrowserError)
    }
}

/// Each provider's authorization and token addresses. Nothing but a test hook moves them.
const PROVIDERS: &[(&str, &str, &str)] = &[(
    "google",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://oauth2.googleapis.com/token",
)];

struct Provider {
    authorize: String,
    /// `None` where a build with test hooks names no provider to ask.
    token: Option<String>,
    /// A stand-in on this machine, reached over plain HTTP.
    local: bool,
}

fn provider(chosen: &SignInProvider, name: &str) -> Result<Provider> {
    let (_, authorize, token) = PROVIDERS
        .iter()
        .find(|(held, _, _)| *held == name)
        .ok_or_else(|| Refusal::internal(&format!("no sign-in provider is named {name}")))?;
    Ok(match chosen {
        SignInProvider::Public => Provider {
            authorize: (*authorize).to_string(),
            token: Some((*token).to_string()),
            local: false,
        },
        SignInProvider::Nowhere => Provider {
            authorize: (*authorize).to_string(),
            token: None,
            local: false,
        },
        SignInProvider::At(origin) => {
            let origin = origin.trim_end_matches('/');
            Provider {
                authorize: format!("{origin}/authorize"),
                token: Some(format!("{origin}/token")),
                local: true,
            }
        }
    })
}

fn not_declared(plugin: &str) -> Refusal {
    Refusal::new(
        Code::ConnectorSignInNotDeclared,
        format!("Plugin {plugin}'s connector declares no sign-in."),
    )
    .with_detail("plugin", plugin)
}

fn settings_missing(plugin: &str, missing: Vec<String>) -> Refusal {
    Refusal::new(
        Code::ConnectorSignInSettingsMissing,
        format!(
            "Set {} on plugin {plugin}'s connector before signing in.",
            missing.join(" and ")
        ),
    )
    .with_detail("settings", missing)
}

fn random_text() -> Result<String> {
    let mut bytes = [0u8; RANDOM_BYTES];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::internal("no randomness was available"))?;
    Ok(BASE64_URL_SAFE_NO_PAD.encode(bytes))
}

fn state_hash(state: &str) -> String {
    hex::encode(Sha256::digest(state.as_bytes()))
}

fn sealed_as(id: &str) -> String {
    format!("connector-sign-in:{id}")
}

/// Counts a callback from `address`, refusing one past the limit.
pub fn hold_callback(app: &App, address: Option<std::net::IpAddr>) -> Result<()> {
    hold_to(
        app,
        connector_sign_in_lanes(address),
        "Too many sign-ins came back to this address. Try again later.",
    )
}

/// The managing permission, judged before the body is read.
pub fn require_manager(caller: &Caller) -> Result<()> {
    caller.require(Permission::ConnectorsManage)
}

/// Where the callback sends the browser, as far as can be judged before the write.
#[derive(Debug)]
pub enum ReturnTo {
    None,
    /// A path on this server, as the browser will be sent there.
    Here(String),
    /// Text that names no path here, which only the calling app's own registration can allow.
    ForApp(String),
}

fn return_to_refused(origin: &str, app: bool) -> Refusal {
    let also = if app {
        ", or a redirect URI this app registered"
    } else {
        ""
    };
    Refusal::validation(format!(
        "return_to must name a path or an address on this server{also}."
    ))
    .with_detail(
        "errors",
        vec![json!({
            "path": "return_to",
            "message": format!(
                "return_to takes text of 1 to {RETURN_TO_CAP} characters naming a path, or an address on {origin}{also}"
            ),
        })],
    )
}

/// `return_to` judged by its text and the kind of caller, or a refusal naming it.
pub fn judged_return_to(
    app: &App,
    caller: &Caller,
    mut body: Map<String, Value>,
) -> Result<ReturnTo> {
    let Some(given) = body.remove("return_to") else {
        return Ok(ReturnTo::None);
    };
    let origin = app.addresses().sign_in().origin().to_string();
    let Some(text) = given
        .as_str()
        .filter(|text| (1..=RETURN_TO_CAP).contains(&text.chars().count()))
    else {
        return Err(return_to_refused(&origin, false));
    };
    match return_to::judged(text, &origin) {
        Some(here) => Ok(ReturnTo::Here(here)),
        None if matches!(caller, Caller::App { .. }) => Ok(ReturnTo::ForApp(text.to_string())),
        None => Err(return_to_refused(&origin, false)),
    }
}

/// The text exactly as the calling app's OAuth client registered it, or a refusal.
fn for_app(tx: &Transaction<'_>, caller: &Caller, text: String, origin: &str) -> Result<String> {
    let Caller::App { grant, .. } = caller else {
        return Err(return_to_refused(origin, false));
    };
    let registered = oauth::store::client(tx, &grant.client_id)?
        .is_some_and(|client| client.registration.redirect_uris.contains(&text));
    if registered {
        Ok(text)
    } else {
        Err(return_to_refused(origin, true))
    }
}

fn authorization_url(
    provider: &Provider,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
) -> Result<String> {
    let mut url = Url::parse(&provider.authorize)
        .map_err(|_| Refusal::internal("a sign-in provider's address did not read"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

/// The connector's `sign_in`, refused where it declares none.
fn declared(connector: &ForSignIn, plugin: &str) -> Result<marfa_rules::plugin_connector::SignIn> {
    connector
        .sign_in
        .clone()
        .ok_or_else(|| not_declared(plugin))
}

pub async fn start(
    app: &App,
    caller: &Caller,
    plugin: String,
    return_to: ReturnTo,
) -> Result<Value> {
    let state = random_text()?;
    let verifier = random_text()?;
    let challenge = BASE64_URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let id = uuid::Uuid::now_v7().to_string();
    let sealer = app.settings.shared_sealer();
    let chosen = app.faults.sign_in_provider();
    let origin = app.addresses().sign_in().origin().to_string();
    let redirect_uri = format!("{origin}{CALLBACK_PATH}");
    app.write(caller, STARTED, move |unit| {
        unit.caller.require(Permission::ConnectorsManage)?;
        let tx = unit.tx();
        let return_to = match return_to {
            ReturnTo::None => None,
            ReturnTo::Here(here) => Some(here),
            ReturnTo::ForApp(text) => Some(for_app(tx, &unit.caller, text, &origin)?),
        };
        let connector = connector_settings::for_sign_in(tx, &plugin)?;
        let sign_in = declared(&connector, &plugin)?;
        let client_id = connector.text(&sign_in.client_id_setting, &sealer)?;
        let has_secret = connector
            .text(&sign_in.client_secret_setting, &sealer)?
            .is_some();
        let missing: Vec<String> = [
            (&sign_in.client_id_setting, client_id.is_some()),
            (&sign_in.client_secret_setting, has_secret),
        ]
        .into_iter()
        .filter(|(_, set)| !set)
        .map(|(name, _)| name.clone())
        .collect();
        let Some(client_id) = client_id.filter(|_| missing.is_empty()) else {
            return Err(settings_missing(&plugin, missing));
        };
        let provider = provider(&chosen, &sign_in.provider)?;
        let sealed = sealer
            .seal(&sealed_as(&id), &Secret::new(verifier.clone()))
            .ok_or_else(|| Refusal::internal("a sign-in's verifier could not be sealed"))?;
        let expires_at = Stamp::read(&unit.at)?.plus_ms(LIFE_MS)?.text();
        tx.execute(
            "INSERT INTO connector_sign_ins (plugin, id, install, state_hash, verifier, \
             redirect_uri, return_to, started_at, expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (plugin) DO UPDATE SET \
             id = excluded.id, install = excluded.install, state_hash = excluded.state_hash, \
             verifier = excluded.verifier, redirect_uri = excluded.redirect_uri, \
             return_to = excluded.return_to, started_at = excluded.started_at, \
             expires_at = excluded.expires_at, exchanging_at = NULL, outcome = NULL, \
             reason = NULL, ended_at = NULL",
            params![
                plugin,
                id,
                connector.install,
                state_hash(&state),
                sealed,
                redirect_uri,
                return_to,
                unit.at,
                expires_at
            ],
        )?;
        unit.audit("plugin", &plugin, None)?;
        let url = authorization_url(
            &provider,
            &client_id,
            &redirect_uri,
            &sign_in.scopes,
            &state,
            &challenge,
        )?;
        Ok(json!({ "id": id, "url": url, "expires_at": expires_at }))
    })
    .await
}

struct Latest {
    id: String,
    started_at: String,
    expires_at: String,
    exchanging_at: Option<String>,
    outcome: Option<String>,
    reason: Option<String>,
    ended_at: Option<String>,
}

pub async fn status(app: &App, caller: &Caller, plugin: String) -> Result<Value> {
    connectors::reading(app, caller, move |tx, caller, at| {
        caller.require(Permission::ConnectorsManage)?;
        let connector = connector_settings::for_sign_in(tx, &plugin)?;
        declared(&connector, &plugin)?;
        let latest = tx
            .prepare_cached(
                "SELECT id, started_at, expires_at, exchanging_at, outcome, reason, ended_at \
                 FROM connector_sign_ins WHERE plugin = ?1",
            )?
            .query_row([&plugin], |row| {
                Ok(Latest {
                    id: row.get(0)?,
                    started_at: row.get(1)?,
                    expires_at: row.get(2)?,
                    exchanging_at: row.get(3)?,
                    outcome: row.get(4)?,
                    reason: row.get(5)?,
                    ended_at: row.get(6)?,
                })
            })
            .optional()?;
        let Some(Latest {
            id,
            started_at,
            expires_at,
            exchanging_at,
            outcome,
            reason,
            ended_at,
        }) = latest
        else {
            return Ok(json!({
                "plugin": plugin,
                "status": "none",
                "reason": null,
                "id": null,
                "started_at": null,
                "expires_at": null,
                "ended_at": null,
            }));
        };
        let now = Stamp::read(at)?;
        let unread = || Refusal::unread("a sign-in's stored outcome did not read");
        let failure = match (outcome.as_deref(), reason.as_deref()) {
            (Some("failed"), Some(word)) => Some(Failure::read(word).ok_or_else(unread)?),
            (Some("failed"), None) | (_, Some(_)) => return Err(unread()),
            _ => None,
        };
        let status = match outcome.as_deref() {
            Some("signed_in") => "signed_in",
            Some("failed") => "failed",
            Some(_) => return Err(unread()),
            None => {
                let lapsed = Stamp::read(&expires_at)? <= now;
                let claimed = match exchanging_at.as_deref() {
                    Some(claimed) => Stamp::read(claimed)?.plus_ms(CLAIM_GRACE_MS)? > now,
                    None => false,
                };
                if lapsed && !claimed {
                    "expired"
                } else {
                    "pending"
                }
            }
        };
        Ok(json!({
            "plugin": plugin,
            "status": status,
            "reason": failure.map(|failure| failure.word()),
            "id": id,
            "started_at": started_at,
            "expires_at": expires_at,
            "ended_at": ended_at,
        }))
    })
    .await
}

/// How the callback answers the owner's browser. None of them carries what the provider sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Finished {
    /// To the sign-in's `return_to`, with `signed_in`.
    Back(String),
    SignedIn,
    /// The state names no pending sign-in.
    NotFinished,
    /// The browser came back without a code, or the sign-in no longer holds.
    Ended(Failure),
    /// The token request failed.
    ProviderFailed(Failure),
}

/// What the token request needs, read and claimed in one write.
struct Exchange {
    id: String,
    plugin: String,
    install: String,
    token_setting: String,
    token: Option<String>,
    local: bool,
    form: String,
    return_to: Option<String>,
}

enum Claim {
    Unknown,
    Ended(Failure),
    Exchange(Box<Exchange>),
}

fn end(tx: &Transaction<'_>, id: &str, failure: Option<&Failure>, at: &str) -> Result<()> {
    let outcome = if failure.is_some() {
        "failed"
    } else {
        "signed_in"
    };
    tx.execute(
        "UPDATE connector_sign_ins SET outcome = ?2, reason = ?3, ended_at = ?4, verifier = '' \
         WHERE id = ?1",
        params![id, outcome, failure.map(Failure::word), at],
    )?;
    Ok(())
}

fn record_failure(unit: &Unit<'_, '_>, id: &str, plugin: &str, failure: &Failure) -> Result<()> {
    end(unit.tx(), id, Some(failure), &unit.at)?;
    unit.audit_also(
        FAILED,
        "plugin",
        plugin,
        Some(json!({ "outcome": failure.word() })),
    )
}

fn fail(unit: &Unit<'_, '_>, id: &str, plugin: &str, failure: Failure) -> Result<Claim> {
    record_failure(unit, id, plugin, &failure)?;
    Ok(Claim::Ended(failure))
}

struct Pending {
    plugin: String,
    id: String,
    install: String,
    verifier: String,
    redirect_uri: String,
    return_to: Option<String>,
    expires_at: String,
}

fn claim(
    unit: &Unit<'_, '_>,
    hash: &str,
    code: Option<String>,
    error: Option<String>,
    sealer: &Sealer,
    chosen: &SignInProvider,
) -> Result<Claim> {
    let tx = unit.tx();
    let pending = tx
        .prepare_cached(
            "SELECT plugin, id, install, verifier, redirect_uri, return_to, expires_at \
             FROM connector_sign_ins \
             WHERE state_hash = ?1 AND outcome IS NULL AND exchanging_at IS NULL",
        )?
        .query_row([hash], |row| {
            Ok(Pending {
                plugin: row.get(0)?,
                id: row.get(1)?,
                install: row.get(2)?,
                verifier: row.get(3)?,
                redirect_uri: row.get(4)?,
                return_to: row.get(5)?,
                expires_at: row.get(6)?,
            })
        })
        .optional()?;
    let Some(pending) = pending else {
        return Ok(Claim::Unknown);
    };
    if Stamp::read(&pending.expires_at)? <= Stamp::read(&unit.at)? {
        return Ok(Claim::Unknown);
    }
    if let Some(error) = error {
        return fail(
            unit,
            &pending.id,
            &pending.plugin,
            Failure::of_browser(&error),
        );
    }
    let Some(code) = code else {
        return fail(unit, &pending.id, &pending.plugin, Failure::NoCode);
    };
    let connector = connector_settings::for_sign_in(tx, &pending.plugin)?;
    let Some(sign_in) = connector.sign_in.clone() else {
        return fail(
            unit,
            &pending.id,
            &pending.plugin,
            Failure::ChangedSinceStart,
        );
    };
    let client_id = connector.text(&sign_in.client_id_setting, sealer)?;
    let client_secret = connector.text(&sign_in.client_secret_setting, sealer)?;
    let verifier = sealer.open(&sealed_as(&pending.id), &pending.verifier);
    let (Some(client_id), Some(client_secret), Some(verifier), true) = (
        client_id,
        client_secret,
        verifier,
        connector.install == pending.install,
    ) else {
        return fail(
            unit,
            &pending.id,
            &pending.plugin,
            Failure::ChangedSinceStart,
        );
    };
    let provider = provider(chosen, &sign_in.provider)?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", &code)
        .append_pair("redirect_uri", &pending.redirect_uri)
        .append_pair("client_id", &client_id)
        .append_pair("client_secret", &client_secret)
        .append_pair("code_verifier", verifier.expose())
        .finish();
    tx.execute(
        "UPDATE connector_sign_ins SET exchanging_at = ?2 WHERE id = ?1",
        params![pending.id, unit.at],
    )?;
    Ok(Claim::Exchange(Box::new(Exchange {
        id: pending.id,
        plugin: pending.plugin,
        install: pending.install,
        token_setting: sign_in.token_setting,
        token: provider.token,
        local: provider.local,
        form,
        return_to: pending.return_to,
    })))
}

/// The answer's body, read with no more than its cap.
fn capped_body(
    response: &mut ureq::http::Response<ureq::Body>,
) -> std::result::Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(ANSWER_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::TimedOut => Failure::Timeout,
            _ => Failure::UnreadableAnswer,
        })?;
    if bytes.len() as u64 > ANSWER_CAP {
        return Err(Failure::UnreadableAnswer);
    }
    Ok(bytes)
}

/// The refresh token a `200` answer names, or the word for why there is none.
fn refresh_token_of(
    mut response: ureq::http::Response<ureq::Body>,
) -> std::result::Result<String, Failure> {
    let status = response.status().as_u16();
    if status != 200 {
        let named = capped_body(&mut response)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|answer| {
                let error = answer.get("error")?.as_str()?.to_string();
                fixed(TOKEN_ERRORS, &error)
            });
        return Err(named.map_or(Failure::Status(status), Failure::TokenError));
    }
    let bytes = capped_body(&mut response)?;
    let answer: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::UnreadableAnswer)?;
    let object = answer.as_object().ok_or(Failure::UnreadableAnswer)?;
    match object.get("refresh_token") {
        None => Err(Failure::NoRefreshToken),
        Some(Value::String(token)) => Ok(token.clone()),
        Some(_) => Err(Failure::UnreadableAnswer),
    }
}

/// Blocks. Redirects are never followed.
fn post_form(
    url: &Url,
    addresses: Vec<SocketAddr>,
    form: String,
    local: bool,
    bound: Duration,
) -> std::result::Result<String, Failure> {
    let tls = TlsConfig::builder()
        .root_certs(RootCerts::PlatformVerifier)
        .build();
    let config = Agent::config_builder()
        .https_only(!local)
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(bound))
        .max_response_header_size(MAX_HEADER_BYTES)
        .tls_config(tls)
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")))
        .build();
    let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(addresses));
    let response = agent
        .post(url.as_str())
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .send(form)
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => Failure::Timeout,
            _ => Failure::Unreachable,
        })?;
    refresh_token_of(response)
}

/// The one request a sign-in sends: the token request, to the provider's token address.
async fn exchange(
    app: &App,
    token: Option<&str>,
    local: bool,
    form: String,
) -> std::result::Result<String, Failure> {
    let url = token
        .and_then(|token| Url::parse(token).ok())
        .ok_or(Failure::Unreachable)?;
    let port = url.port_or_known_default().ok_or(Failure::Unreachable)?;
    let bound = app.faults.sign_in_deadline().unwrap_or(EXCHANGE_BOUND);
    let asked = async {
        let targets = match outbound::reach(&app.faults, &url, local, Asker::ConnectorSignIn).await
        {
            Reach::Targets(targets) => targets,
            Reach::Unresolved | Reach::NoSlot | Reach::NotPublic => {
                return Err(Failure::Unreachable);
            }
        };
        let addresses = targets
            .into_iter()
            .map(|target| SocketAddr::new(target.connected, port))
            .collect();
        tokio::task::spawn_blocking(move || post_form(&url, addresses, form, local, bound))
            .await
            .map_err(|_| Failure::Unreachable)?
    };
    tokio::time::timeout(bound, asked)
        .await
        .map_err(|_| Failure::Timeout)?
}

fn with_signed_in(back: &str, plugin: &str) -> String {
    let (before, fragment) = back.split_at(back.find('#').unwrap_or(back.len()));
    let joiner = if before.contains('?') { '&' } else { '?' };
    format!(
        "{before}{joiner}signed_in={}{fragment}",
        return_to::encoded(plugin)
    )
}

/// The callback a provider sends the owner's browser to. It asks for no credential: the state is one.
pub async fn callback(
    app: &App,
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
) -> Result<Finished> {
    let Some(state) = state.filter(|state| (1..=STATE_CAP).contains(&state.len())) else {
        return Ok(Finished::NotFinished);
    };
    let hash = state_hash(&state);
    let sealer = app.settings.shared_sealer();
    let chosen = app.faults.sign_in_provider();
    let claimed = app
        .write(&Caller::Server, CLAIMED, move |unit| {
            claim(unit, &hash, code, error, &sealer, &chosen)
        })
        .await?;
    let exchange_of = match claimed {
        Claim::Unknown => return Ok(Finished::NotFinished),
        Claim::Ended(failure) => return Ok(Finished::Ended(failure)),
        Claim::Exchange(exchange_of) => *exchange_of,
    };
    let Exchange {
        id,
        plugin,
        install,
        token_setting,
        token,
        local,
        form,
        return_to,
    } = exchange_of;
    let refresh = exchange(app, token.as_deref(), local, form).await;
    let sealer = app.settings.shared_sealer();
    let named = plugin.clone();
    let stored = app
        .write(&Caller::Server, FINISHED, move |unit| {
            let tx = unit.tx();
            let pending: Option<String> = tx
                .prepare_cached(
                    "SELECT plugin FROM connector_sign_ins WHERE id = ?1 AND outcome IS NULL",
                )?
                .query_row([&id], |row| row.get(0))
                .optional()?;
            if pending.is_none() {
                return Ok(None);
            }
            let connector = connector_settings::for_sign_in(tx, &plugin)?;
            let stored = match refresh {
                Ok(_) if connector.install != install => Err(Failure::ChangedSinceStart),
                Ok(token) => {
                    if connector.store_secret(tx, &token_setting, &token, &sealer, &unit.at)? {
                        Ok(())
                    } else {
                        Err(Failure::UnreadableAnswer)
                    }
                }
                Err(failure) => Err(failure),
            };
            match &stored {
                Ok(()) => {
                    end(tx, &id, None, &unit.at)?;
                    unit.audit_also(SIGNED_IN, "plugin", &plugin, None)?;
                }
                Err(failure) => record_failure(unit, &id, &plugin, failure)?,
            }
            Ok(Some(stored))
        })
        .await?;
    Ok(match (stored, return_to) {
        (None, _) => Finished::NotFinished,
        (Some(Err(failure)), _) => Finished::ProviderFailed(failure),
        (Some(Ok(())), Some(back)) => Finished::Back(with_signed_in(&back, &named)),
        (Some(Ok(())), None) => Finished::SignedIn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_in_joins_the_query_before_any_fragment() {
        assert_eq!(with_signed_in("/done", "rss"), "/done?signed_in=rss");
        assert_eq!(
            with_signed_in("/done?step=2#part", "rss"),
            "/done?step=2&signed_in=rss#part"
        );
        assert_eq!(with_signed_in("/#top", "a-b"), "/?signed_in=a-b#top");
    }

    #[test]
    fn signed_in_joins_a_private_use_address_the_app_registered() {
        assert_eq!(
            with_signed_in("com.example.app:/done", "rss"),
            "com.example.app:/done?signed_in=rss"
        );
        assert_eq!(
            with_signed_in("com.example.app:/done?from=marfa", "rss"),
            "com.example.app:/done?from=marfa&signed_in=rss"
        );
    }

    #[test]
    fn each_failure_reads_back_from_its_word_and_nothing_else_does() {
        let mut every = vec![
            Failure::ProviderError,
            Failure::NoCode,
            Failure::ChangedSinceStart,
            Failure::Timeout,
            Failure::Unreachable,
            Failure::Status(400),
            Failure::Status(503),
            Failure::NoRefreshToken,
            Failure::UnreadableAnswer,
        ];
        every.extend(TOKEN_ERRORS.iter().map(|word| Failure::TokenError(word)));
        for failure in every {
            let read = Failure::read(&failure.word()).unwrap();
            assert_eq!(read.word(), failure.word());
        }
        assert_eq!(
            Failure::read("access_denied"),
            Some(Failure::BrowserError("access_denied"))
        );
        for stranger in [
            "",
            "status_",
            "status_x",
            "status_0400",
            "status_70000",
            "Invalid_grant",
            "invalid grant",
        ] {
            assert_eq!(Failure::read(stranger), None, "{stranger:?}");
        }
        assert_eq!(Failure::of_browser("access_denied").word(), "access_denied");
        assert_eq!(
            Failure::of_browser("Something the provider wrote").word(),
            "provider_error"
        );
    }

    #[test]
    fn a_release_build_names_only_the_providers_own_addresses() {
        let public = provider(&SignInProvider::Public, "google").unwrap();
        assert_eq!(
            public.authorize,
            "https://accounts.google.com/o/oauth2/v2/auth"
        );
        assert_eq!(
            public.token.as_deref(),
            Some("https://oauth2.googleapis.com/token")
        );
        assert!(!public.local);
        assert!(provider(&SignInProvider::Public, "elsewhere").is_err());
    }
}
