//! Signing in: the device code, the token it becomes, and keeping the token
//! alive.
//!
//! The binary is a public native client of the instance's own authorization
//! server (RFC 8628). It reads the server's discovery document, registers
//! itself once per origin, asks for a device code, shows the person the code
//! and the page, and polls the token door until the person has decided. The
//! token set lives in the keychain (`credentials`), and a refresh is taken
//! under a lock because the server revokes a chain whose rotated refresh
//! token is replayed: two processes started in the same second would
//! otherwise both refresh with one token and sign each other out.

use std::collections::hash_map::DefaultHasher;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::remote::Remote;
use crate::remote::request::Request;

pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Everything the owner can hold at the terminal: the protocol's own
/// scopes (the identity claims `whoami` reads, and the refresh token),
/// every type and edge type either way, metadata, and the seven
/// permissions the glossary names. Held against the server's
/// `scopes_supported` at sign-in, so a scope the server does not publish
/// is not asked for.
const OWNER_SCOPES: [&str; 17] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "*:read",
    "*:write",
    "edge.*:read",
    "edge.*:write",
    "metadata:read",
    "metadata:write",
    "schema.write",
    "keys.mint",
    "items.purge",
    "webhooks.manage",
    "config.manage",
    "audit.read",
    "grants.manage",
];

/// A refresh this close to the access token's end happens before the call
/// rather than after its 401.
const REFRESH_AHEAD_SECONDS: u64 = 60;

/// What the authorization server says about itself, reduced to the doors
/// the binary uses and the scopes it supports.
#[derive(Debug, Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub token_endpoint: String,
    pub device_authorization_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    /// RFC 8414 recommends the list and does not require it; absent, the
    /// default scope is asked for whole.
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// The device code as the server issued it.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_interval() -> u64 {
    5
}

/// A token set as the token door answers it.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Reads the discovery document at the server's own path and holds it to
/// the origin it was read from (RFC 8414 section 3.3): the issuer it names
/// and every door it names are on that origin, or the sign-in is refused.
/// A document is data from the network, and the binary is about to post a
/// person's credential to what it names.
pub fn discover(remote: &Remote) -> Result<Discovery, CliError> {
    let value = remote
        .json(&Request::get(&["auth", ".well-known", "oauth-authorization-server"]).public())?;
    let discovery: Discovery = serde_json::from_value(value).map_err(|error| {
        CliError::Invalid(format!(
            "the discovery document at {} is not one this build reads: {error}",
            remote.origin()
        ))
    })?;
    let read_from = Url::parse(remote.url())
        .map_err(|error| CliError::Invalid(format!("the server url is not a URL: {error}")))?;
    let issuer = Url::parse(&discovery.issuer)
        .map_err(|error| CliError::Invalid(format!("the issuer is not a URL: {error}")))?;
    if issuer.origin() != read_from.origin() {
        return Err(CliError::Invalid(format!(
            "the discovery document at {} names {} as its issuer; refusing to sign in through a server that speaks for another",
            remote.origin(),
            discovery.issuer
        )));
    }
    let doors = [
        Some(&discovery.token_endpoint),
        Some(&discovery.device_authorization_endpoint),
        Some(&discovery.registration_endpoint),
        discovery.revocation_endpoint.as_ref(),
        discovery.userinfo_endpoint.as_ref(),
    ];
    for door in doors.into_iter().flatten() {
        on_issuer(&discovery, door)?;
    }
    Ok(discovery)
}

/// Refuses a URL the server named that is not on the issuer's origin, or
/// is not a web page at all: the doors of the document, and the pages the
/// device code points a browser at.
pub fn on_issuer(discovery: &Discovery, named: &str) -> Result<(), CliError> {
    let issuer = Url::parse(&discovery.issuer)
        .map_err(|error| CliError::Invalid(format!("the issuer is not a URL: {error}")))?;
    let parsed = Url::parse(named)
        .map_err(|error| CliError::Invalid(format!("{named} is not a URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.origin() != issuer.origin() {
        return Err(CliError::Invalid(format!(
            "the server sends {named} off the issuer {}; refusing to sign in",
            discovery.issuer
        )));
    }
    Ok(())
}

/// The pages a device code points a browser at, checked like the doors:
/// the binary is about to hand one to `open`.
pub fn pages_on_issuer(discovery: &Discovery, code: &DeviceCode) -> Result<(), CliError> {
    on_issuer(discovery, &code.verification_uri)?;
    if let Some(complete) = &code.verification_uri_complete {
        on_issuer(discovery, complete)?;
    }
    Ok(())
}

/// Everything the owner can tick, narrowed to what the server says it
/// supports. The consent screen narrows further; asking for less here
/// would hide a toggle the person may want.
pub fn default_scope(discovery: &Discovery) -> Result<String, CliError> {
    let scopes: Vec<&str> = OWNER_SCOPES
        .iter()
        .copied()
        .filter(|scope| {
            discovery.scopes_supported.is_empty()
                || discovery
                    .scopes_supported
                    .iter()
                    .any(|supported| supported == scope)
        })
        .collect();
    if scopes.is_empty() {
        return Err(CliError::Invalid(format!(
            "the server at {} supports none of the scopes an owner signs in with; pass --scope",
            discovery.issuer
        )));
    }
    Ok(scopes.join(" "))
}

/// Registers the binary as a public native client that may use the device
/// grant and refresh. Answers the client id.
pub fn register(discovery: &Discovery) -> Result<String, CliError> {
    let door = Remote::public_at(&discovery.registration_endpoint)?;
    let answer = door.json(&Request::post(&[]).public().json(serde_json::json!({
        "client_name": "marfa",
        "application_type": "native",
        "grant_types": [DEVICE_CODE_GRANT, "refresh_token"],
        "response_types": [],
        "token_endpoint_auth_method": "none",
    })))?;
    answer
        .get("client_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CliError::Invalid("the registration answered no client_id".to_string()))
}

/// Asks for a device code.
pub fn device_code(
    discovery: &Discovery,
    client_id: &str,
    scope: &str,
) -> Result<DeviceCode, CliError> {
    let door = Remote::public_at(&discovery.device_authorization_endpoint)?;
    let answer = door.json(
        &Request::post(&[])
            .public()
            .form(&[("client_id", client_id), ("scope", scope)]),
    )?;
    serde_json::from_value(answer).map_err(|error| {
        CliError::Invalid(format!(
            "the device code answer is not one this build reads: {error}"
        ))
    })
}

/// What one poll of the token door said.
#[derive(Debug)]
pub enum Poll {
    /// The person has not decided.
    Pending,
    /// The server asked for a longer interval.
    SlowDown,
    Token(TokenSet),
}

/// Polls the token door once.
pub fn poll(discovery: &Discovery, client_id: &str, device_code: &str) -> Result<Poll, CliError> {
    let door = Remote::public_at(&discovery.token_endpoint)?;
    let answer = door.json(&Request::post(&[]).public().form(&[
        ("grant_type", DEVICE_CODE_GRANT),
        ("device_code", device_code),
        ("client_id", client_id),
    ]));
    match answer {
        Ok(value) => Ok(Poll::Token(token_set(value)?)),
        Err(CliError::Refused { code, .. }) if code == "authorization_pending" => Ok(Poll::Pending),
        Err(CliError::Refused { code, .. }) if code == "slow_down" => Ok(Poll::SlowDown),
        Err(error) => Err(error),
    }
}

/// Polls until the person has decided or the code has expired, honoring the
/// interval and `slow_down`.
pub fn wait_for_decision(
    discovery: &Discovery,
    client_id: &str,
    code: &DeviceCode,
) -> Result<TokenSet, CliError> {
    let deadline = now_seconds().saturating_add(code.expires_in);
    let mut interval = code.interval.max(1);
    loop {
        // The wait never outlives the code, whatever interval the server
        // asked for.
        let remaining = deadline.saturating_sub(now_seconds());
        if remaining == 0 {
            return Err(CliError::Refused {
                status: 400,
                code: "expired_token".to_string(),
                message: "the code expired before the person decided; run marfa login again"
                    .to_string(),
                retry_after_seconds: None,
                details: None,
            });
        }
        sleep(Duration::from_secs(interval.min(remaining)));
        match poll(discovery, client_id, &code.device_code)? {
            Poll::Token(token) => return Ok(token),
            Poll::Pending => {}
            Poll::SlowDown => interval = interval.saturating_add(5),
        }
    }
}

fn token_set(value: Value) -> Result<TokenSet, CliError> {
    serde_json::from_value(value).map_err(|error| {
        CliError::Invalid(format!(
            "the token answer is not one this build reads: {error}"
        ))
    })
}

/// The keychain entry a token set becomes.
pub fn kept(token: &TokenSet, client_id: &str, discovery: &Discovery) -> Kept {
    Kept::Token {
        access_token: token.access_token.clone(),
        refresh_token: token.refresh_token.clone(),
        expires_at: token
            .expires_in
            .map(|seconds| now_seconds().saturating_add(seconds)),
        client_id: client_id.to_string(),
        scope: token.scope.clone(),
        token_endpoint: discovery.token_endpoint.clone(),
        revocation_endpoint: discovery.revocation_endpoint.clone(),
    }
}

/// Whether a kept token should be refreshed before it is used.
pub fn is_stale(kept: &Kept) -> bool {
    match kept {
        Kept::Token {
            expires_at: Some(expires_at),
            refresh_token: Some(_),
            ..
        } => now_seconds().saturating_add(REFRESH_AHEAD_SECONDS) >= *expires_at,
        _ => false,
    }
}

/// Refreshes the token kept for an origin and keeps the new set, under the
/// lock, re-reading the keychain first: another process may have refreshed
/// while this one waited, in which case its set is the live one and a second
/// refresh would replay a rotated token.
///
/// `refused` is the bearer a call was just answered `401` with. The refresh
/// then happens only if that bearer is still the kept one; a set already
/// rotated by another process is answered as it is. Without it, the refresh
/// happens only for a stale set.
pub fn refresh(origin: &str, refused: Option<&str>) -> Result<Kept, CliError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(origin)?)?;
    let mut lock = fd_lock::RwLock::new(file);
    let _held = lock.write()?;

    let current = credentials::read(origin)?.ok_or_else(|| signed_out(origin))?;
    let (refresh_token, client_id, token_endpoint) = match &current {
        Kept::Token {
            refresh_token: Some(refresh_token),
            client_id,
            token_endpoint,
            ..
        } => (
            refresh_token.clone(),
            client_id.clone(),
            token_endpoint.clone(),
        ),
        Kept::Token { .. } => return Err(signed_out(origin)),
        Kept::Key { .. } => return Ok(current),
    };
    let due = match refused {
        Some(bearer) => current.bearer() == bearer,
        None => is_stale(&current),
    };
    if !due {
        return Ok(current);
    }
    let door = Remote::public_at(&token_endpoint)?;
    let answer = door.json(&Request::post(&[]).public().form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh_token),
        ("client_id", &client_id),
    ]));
    let token = match answer {
        Ok(value) => token_set(value)?,
        // The grant is dead: revoked, replayed, expired, or issued to a
        // client the server has forgotten. The token goes and the origin
        // stays current, so the next command is refused for want of a
        // credential and names `marfa login`. Any other refusal, a 429
        // among them, is the server's answer to this call and leaves the
        // set alone.
        Err(CliError::Refused { code, .. })
            if code == "invalid_grant" || code == "invalid_client" =>
        {
            credentials::drop(origin)?;
            return Err(signed_out(origin));
        }
        Err(error) => return Err(error),
    };
    let next = match &current {
        Kept::Token {
            scope,
            revocation_endpoint,
            ..
        } => Kept::Token {
            access_token: token.access_token,
            // A server that does not rotate answers no refresh token, and
            // the one held stays good.
            refresh_token: token.refresh_token.or(Some(refresh_token)),
            expires_at: token
                .expires_in
                .map(|seconds| now_seconds().saturating_add(seconds)),
            client_id,
            scope: token.scope.or_else(|| scope.clone()),
            token_endpoint,
            revocation_endpoint: revocation_endpoint.clone(),
        },
        Kept::Key { .. } => unreachable!("a key was answered above"),
    };
    if let Err(error) = credentials::keep(origin, &next) {
        // The server has rotated and the keychain would not take the new
        // set: the kept refresh token is spent, and replaying it would
        // revoke the chain, so the entry goes and the reason is the answer.
        let _ = credentials::drop(origin);
        return Err(match error {
            CliError::NoKeychain(reason) => CliError::NoKeychain(format!(
                "{reason}; the refreshed token could not be kept, so the sign-in ended: run marfa login"
            )),
            other => other,
        });
    }
    Ok(next)
}

/// Where the refresh lock for an origin lives: a directory of this user's
/// alone under the runtime directory where the system has one, else the
/// temp directory, made for them and checked to be theirs, because a
/// shared `/tmp` lets another user plant the file first and hold its lock
/// against every refresh.
fn lock_path(origin: &str) -> Result<PathBuf, CliError> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("marfa-{}", user_id()));
    own_directory(&dir)?;
    Ok(dir.join(format!("refresh-{}.lock", fingerprint(origin))))
}

#[cfg(unix)]
fn user_id() -> u32 {
    // Safe: getuid takes nothing and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(unix)]
fn own_directory(dir: &std::path::Path) -> Result<(), CliError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::metadata(dir)?;
    if !metadata.is_dir()
        || metadata.uid() != user_id()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(CliError::Invalid(format!(
            "{} is not a directory of this user's alone; refusing to take the refresh lock there",
            dir.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn user_id() -> u32 {
    0
}

#[cfg(not(unix))]
fn own_directory(dir: &std::path::Path) -> Result<(), CliError> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Tells the server the token set is done with: the refresh token where
/// there is one, since revoking it ends the whole chain, else the access
/// token. A kept key has nothing to revoke.
pub fn revoke(kept: &Kept) -> Result<(), CliError> {
    if let Kept::Token {
        refresh_token,
        access_token,
        client_id,
        revocation_endpoint: Some(revocation_endpoint),
        ..
    } = kept
    {
        let door = Remote::public_at(revocation_endpoint)?;
        let (token, hint) = match refresh_token {
            Some(refresh_token) => (refresh_token.as_str(), "refresh_token"),
            None => (access_token.as_str(), "access_token"),
        };
        door.json(&Request::post(&[]).public().form(&[
            ("token", token),
            ("token_type_hint", hint),
            ("client_id", client_id),
        ]))?;
    }
    Ok(())
}

pub fn signed_out(origin: &str) -> CliError {
    CliError::SignedOut {
        origin: origin.to_string(),
    }
}

fn fingerprint(origin: &str) -> String {
    let mut hasher = DefaultHasher::new();
    origin.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door};

    /// A token door with one answer, and the endpoint a kept token names.
    fn token_door(status: &'static str, body: &str) -> (String, Door) {
        let door = Door::open(vec![Answer::json(status, body)]);
        let endpoint = format!("{}/token", door.url);
        (endpoint, door)
    }

    fn token(token_endpoint: &str, expires_at: Option<u64>, refresh_token: Option<&str>) -> Kept {
        Kept::Token {
            access_token: "marfa_at_old".into(),
            refresh_token: refresh_token.map(str::to_string),
            expires_at,
            client_id: "client".into(),
            scope: Some("*:read".into()),
            token_endpoint: token_endpoint.to_string(),
            revocation_endpoint: None,
        }
    }

    fn stale_token(token_endpoint: &str) -> Kept {
        token(token_endpoint, Some(1), Some("marfa_rt_old"))
    }

    /// A discovery document whose doors sit on `origin`, naming
    /// `issuer_origin` as its issuer, supporting a few of the owner's
    /// scopes and one that is nobody's default.
    fn document(origin: &str, issuer_origin: &str) -> String {
        serde_json::json!({
            "issuer": format!("{issuer_origin}/auth"),
            "token_endpoint": format!("{origin}/auth/oauth2/token"),
            "device_authorization_endpoint": format!("{origin}/auth/device/code"),
            "registration_endpoint": format!("{origin}/auth/oauth2/register"),
            "revocation_endpoint": format!("{origin}/auth/oauth2/revoke"),
            "userinfo_endpoint": format!("{origin}/auth/oauth2/userinfo"),
            "scopes_supported": ["openid", "offline_access", "*:read", "core.note:read", "keys.mint"]
        })
        .to_string()
    }

    /// An origin on the loopback interface that nothing listens on, from a
    /// door opened and closed for its port.
    fn closed_origin() -> String {
        let door = Door::open(vec![]);
        let origin = door.url.clone();
        door.received();
        origin
    }

    /// Keeps a token for a test, or says why the keychain did not answer.
    fn keep_or_skip(origin: &str, kept: &Kept) -> bool {
        match credentials::keep(origin, kept) {
            Ok(()) => true,
            Err(CliError::NoKeychain(reason)) => {
                credentials::skipped(&reason);
                false
            }
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn a_stale_token_is_one_within_a_minute_of_its_end_that_can_be_refreshed() {
        let door = "http://door.invalid/token";
        assert!(is_stale(&stale_token(door)));
        assert!(!is_stale(&token(
            door,
            Some(now_seconds() + 3600),
            Some("marfa_rt_old")
        )));
        assert!(is_stale(&token(
            door,
            Some(now_seconds() + 30),
            Some("marfa_rt_old")
        )));
        assert!(
            !is_stale(&token(door, Some(1), None)),
            "without a refresh token there is nothing to refresh with"
        );
        assert!(!is_stale(&Kept::Key {
            key: "marfa_k1_x".into()
        }));
    }

    /// A document read from its own origin is read whole and narrows the
    /// default scope to what it supports; the same document naming another
    /// issuer, or one door on another port, is refused.
    #[test]
    fn discovery_is_held_to_the_origin_it_was_read_from() {
        let elsewhere = "https://elsewhere.invalid";

        let door = Door::open_at(|own| vec![Answer::json("200 OK", &document(own, own))]);
        let discovery = discover(&Remote::public_at(&door.url).unwrap()).unwrap();
        assert_eq!(
            door.received()[0].path(),
            "/auth/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            default_scope(&discovery).unwrap(),
            "openid offline_access *:read keys.mint",
            "the owner's scopes the server supports, in the owner's order, and none it does not"
        );
        let mut unlisted = discovery.clone();
        unlisted.scopes_supported.clear();
        assert_eq!(
            default_scope(&unlisted).unwrap(),
            OWNER_SCOPES.join(" "),
            "a document that does not list its scopes is asked for the whole default"
        );
        let mut foreign = discovery.clone();
        foreign.scopes_supported = vec!["core.note:read".into()];
        assert!(matches!(default_scope(&foreign), Err(CliError::Invalid(_))));
        let issuer_origin = Url::parse(&discovery.issuer)
            .unwrap()
            .origin()
            .ascii_serialization();
        assert!(on_issuer(&discovery, &format!("{issuer_origin}/auth/device")).is_ok());
        assert!(
            on_issuer(&discovery, &format!("{elsewhere}/auth/device")).is_err(),
            "a page off the issuer is not opened"
        );
        assert!(
            on_issuer(&discovery, "file:///etc/passwd").is_err(),
            "a page that is not a web page is not opened"
        );
        assert!(
            on_issuer(&discovery, &format!("blob:{issuer_origin}/x")).is_err(),
            "a blob URL carries its inner origin, so only the scheme check refuses it"
        );
        let code = DeviceCode {
            device_code: "dc".into(),
            user_code: "ABCD1234".into(),
            verification_uri: format!("{issuer_origin}/auth/device"),
            verification_uri_complete: Some(format!("{elsewhere}/auth/device?user_code=ABCD1234")),
            expires_in: 600,
            interval: 5,
        };
        assert!(
            pages_on_issuer(&discovery, &code).is_err(),
            "the complete page is checked as well as the plain one"
        );
        let code = DeviceCode {
            verification_uri_complete: None,
            ..code
        };
        assert!(pages_on_issuer(&discovery, &code).is_ok());

        let door = Door::open_at(|own| vec![Answer::json("200 OK", &document(own, elsewhere))]);
        let refused = discover(&Remote::public_at(&door.url).unwrap());
        door.received();
        assert!(
            matches!(&refused, Err(CliError::Invalid(message)) if message.contains("speaks for another")),
            "{refused:?}"
        );

        let other_port = closed_origin();
        let door = Door::open_at(|own| {
            let mut moved: Value = serde_json::from_str(&document(own, own)).unwrap();
            moved["token_endpoint"] = Value::String(format!("{other_port}/auth/oauth2/token"));
            vec![Answer::json("200 OK", &moved.to_string())]
        });
        let refused = discover(&Remote::public_at(&door.url).unwrap());
        door.received();
        assert!(
            matches!(&refused, Err(CliError::Invalid(message)) if message.contains("off the issuer")),
            "{refused:?}"
        );
    }

    /// The token door's two ways of saying "not yet" are read as such, a
    /// refusal is carried, and a decision is a token.
    #[test]
    fn a_poll_reads_pending_slow_down_a_refusal_and_a_token() {
        let door = Door::open(vec![
            Answer::json("400 Bad Request", r#"{"error":"authorization_pending"}"#),
            Answer::json("400 Bad Request", r#"{"error":"slow_down"}"#),
            Answer::json(
                "400 Bad Request",
                r#"{"error":"access_denied","error_description":"the person declined"}"#,
            ),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_1","token_type":"Bearer","expires_in":3600}"#,
            ),
        ]);
        let discovery: Discovery = serde_json::from_str(&document(&door.url, &door.url)).unwrap();
        assert!(matches!(
            poll(&discovery, "client", "dc").unwrap(),
            Poll::Pending
        ));
        assert!(matches!(
            poll(&discovery, "client", "dc").unwrap(),
            Poll::SlowDown
        ));
        match poll(&discovery, "client", "dc") {
            Err(CliError::Refused { code, .. }) => assert_eq!(code, "access_denied"),
            other => panic!("{other:?}"),
        }
        match poll(&discovery, "client", "dc").unwrap() {
            Poll::Token(token) => assert_eq!(token.access_token, "marfa_at_1"),
            other => panic!("{other:?}"),
        }
        let sent = door.received();
        assert_eq!(sent.len(), 4);
        assert_eq!(sent[0].path(), "/auth/oauth2/token");
        assert!(
            sent[0]
                .body
                .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"),
            "{}",
            sent[0].body
        );
        assert!(sent[0].body.contains("device_code=dc"), "{}", sent[0].body);
    }

    /// The refresh, through the real keychain, against a door on a local
    /// port: the rotated pair is kept, and the refresh token the server
    /// sent replaces the one that was spent, sent once.
    #[test]
    fn a_refresh_keeps_the_rotated_pair_and_sends_the_spent_token_once() {
        let origin = format!("https://refresh.invalid:{}", std::process::id());
        let _keychain = credentials::hold(&origin);
        let (endpoint, door) = token_door(
            "200 OK",
            r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer","scope":"*:read"}"#,
        );
        if !keep_or_skip(&origin, &stale_token(&endpoint)) {
            return;
        }
        let outcome = refresh(&origin, None);
        let received = door.received();
        assert_eq!(received.len(), 1);
        let sent = &received[0];
        assert_eq!(sent.method(), "POST");
        assert_eq!(sent.path(), "/token");
        assert_eq!(
            sent.header("content-type"),
            Some("application/x-www-form-urlencoded")
        );
        assert!(
            sent.body.contains("grant_type=refresh_token"),
            "{}",
            sent.body
        );
        assert!(
            sent.body.contains("refresh_token=marfa_rt_old"),
            "{}",
            sent.body
        );
        assert!(sent.body.contains("client_id=client"), "{}", sent.body);
        match outcome.unwrap() {
            Kept::Token {
                access_token,
                refresh_token,
                expires_at,
                ..
            } => {
                assert_eq!(access_token, "marfa_at_new");
                assert_eq!(refresh_token.as_deref(), Some("marfa_rt_new"));
                assert!(expires_at.unwrap() > now_seconds() + 3000);
            }
            Kept::Key { .. } => panic!("a refresh answered a key"),
        }
    }

    /// A set another process rotated while this one waited on the lock is
    /// answered as it is: neither a stale check nor a refused bearer sends
    /// anything when the keychain no longer holds what was seen.
    #[test]
    fn a_set_already_rotated_by_another_process_is_not_refreshed_again() {
        let origin = format!("https://rotated.invalid:{}", std::process::id());
        let _keychain = credentials::hold(&origin);
        // A token door nothing listens on, so a refresh that should not
        // happen fails loudly.
        let endpoint = format!("{}/token", closed_origin());
        let fresh = token(
            &endpoint,
            Some(now_seconds() + 3600),
            Some("marfa_rt_fresh"),
        );
        if !keep_or_skip(&origin, &fresh) {
            return;
        }
        assert_eq!(
            refresh(&origin, None).unwrap(),
            fresh,
            "not stale: nothing to do"
        );
        assert_eq!(
            refresh(&origin, Some("marfa_at_refused_elsewhere")).unwrap(),
            fresh,
            "the refused bearer is not the kept one: another process already refreshed"
        );
    }

    /// A door that refuses the grant ends the sign-in: the entry is gone,
    /// the origin stays current, and the answer is "signed out". A door that
    /// refuses the call for another reason leaves the set alone, and the
    /// witness is the same entry surviving a 429.
    #[test]
    fn a_dead_grant_ends_the_sign_in_and_any_other_refusal_leaves_it() {
        let origin = format!("https://refused.invalid:{}", std::process::id());
        let _keychain = credentials::hold(&origin);
        let (endpoint, door) = token_door(
            "429 Too Many Requests",
            r#"{"error":{"code":"rate_limited","message":"slow down"}}"#,
        );
        if !keep_or_skip(&origin, &stale_token(&endpoint)) {
            return;
        }
        let outcome = refresh(&origin, None);
        door.received();
        assert!(
            matches!(outcome, Err(CliError::Refused { status: 429, .. })),
            "{outcome:?}"
        );
        assert_eq!(
            credentials::read(&origin).unwrap(),
            Some(stale_token(&endpoint)),
            "a 429 is the server's answer to this call, not the end of the grant"
        );

        let (endpoint, door) = token_door(
            "400 Bad Request",
            r#"{"error":"invalid_grant","error_description":"revoked"}"#,
        );
        credentials::keep(&origin, &stale_token(&endpoint)).unwrap();
        let outcome = refresh(&origin, None);
        door.received();
        assert!(
            matches!(outcome, Err(CliError::SignedOut { .. })),
            "{outcome:?}"
        );
        assert_eq!(credentials::read(&origin).unwrap(), None);
        assert_eq!(
            credentials::current().unwrap().as_deref(),
            Some(origin.as_str()),
            "the origin stays current so the next command names the server it lost"
        );
    }
}
