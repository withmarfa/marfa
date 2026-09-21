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
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;

use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::remote::Remote;
use crate::remote::request::Request;

pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Everything the owner can tick on the consent screen. The screen is the
/// narrowing; asking for less here would hide a toggle the person may want.
pub const DEFAULT_SCOPE: &str = "openid profile email offline_access \
*:read *:write edge.*:read edge.*:write metadata:read metadata:write \
schema.write keys.mint items.purge webhooks.manage config.manage audit.read grants.manage";

/// A refresh this close to the access token's end happens before the call
/// rather than after its 401.
const REFRESH_AHEAD_SECONDS: u64 = 60;

/// What the authorization server says about itself, reduced to the doors
/// the binary uses.
#[derive(Debug, Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub token_endpoint: String,
    pub device_authorization_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
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

/// Reads the discovery document at the server's own path and refuses one
/// that sends any door off the issuer's scheme and host, or onto plain http
/// from an https issuer: a document is data from the network, and the
/// binary is about to post a person's credential to what it names.
pub fn discover(remote: &Remote) -> Result<Discovery, CliError> {
    let value = remote
        .json(&Request::get(&["auth", ".well-known", "oauth-authorization-server"]).public())?;
    let discovery: Discovery = serde_json::from_value(value).map_err(|error| {
        CliError::Invalid(format!(
            "the discovery document at {} is not one this build reads: {error}",
            remote.origin()
        ))
    })?;
    let issuer = url::Url::parse(&discovery.issuer)
        .map_err(|error| CliError::Invalid(format!("the issuer is not a URL: {error}")))?;
    let api = url::Url::parse(remote.url())
        .map_err(|error| CliError::Invalid(format!("the server url is not a URL: {error}")))?;
    if api.scheme() == "https" && issuer.scheme() != "https" {
        return Err(CliError::Invalid(format!(
            "the issuer {} is not https while the server is; refusing to sign in over a downgrade",
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
        let parsed = url::Url::parse(door)
            .map_err(|error| CliError::Invalid(format!("{door} is not a URL: {error}")))?;
        if parsed.origin() != issuer.origin() {
            return Err(CliError::Invalid(format!(
                "the discovery document sends {door} off the issuer {}; refusing to sign in",
                discovery.issuer
            )));
        }
    }
    Ok(discovery)
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
    let deadline = now_seconds() + code.expires_in;
    let mut interval = code.interval.max(1);
    loop {
        sleep(Duration::from_secs(interval));
        match poll(discovery, client_id, &code.device_code)? {
            Poll::Token(token) => return Ok(token),
            Poll::Pending => {}
            Poll::SlowDown => interval += 5,
        }
        if now_seconds() >= deadline {
            return Err(CliError::Refused {
                status: 400,
                code: "expired_token".to_string(),
                message: "the code expired before the person decided; run marfa login again"
                    .to_string(),
                retry_after_seconds: None,
                details: None,
            });
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
        expires_at: token.expires_in.map(|seconds| now_seconds() + seconds),
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
        } => now_seconds() + REFRESH_AHEAD_SECONDS >= *expires_at,
        _ => false,
    }
}

/// Refreshes the token kept for an origin and keeps the new set, under the
/// lock, re-reading the keychain first: another process may have refreshed
/// while this one waited, in which case its set is the live one and a second
/// refresh would replay a rotated token.
///
/// `force` refreshes even a set that is not stale, for the call that was
/// just answered `401`.
pub fn refresh(origin: &str, force: bool) -> Result<Kept, CliError> {
    let lock_path =
        std::env::temp_dir().join(format!("marfa-refresh-{}.lock", fingerprint(origin)));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
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
    if !force && !is_stale(&current) {
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
        // A refusal means the chain is dead: revoked, replayed or expired.
        // The entry goes so the next command says "signed out" once rather
        // than every command failing the same way until a logout.
        Err(CliError::Refused { status, .. }) if (400..500).contains(&status) => {
            credentials::forget(origin)?;
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
            expires_at: token.expires_in.map(|seconds| now_seconds() + seconds),
            client_id,
            scope: token.scope.or_else(|| scope.clone()),
            token_endpoint,
            revocation_endpoint: revocation_endpoint.clone(),
        },
        Kept::Key { .. } => unreachable!("a key was answered above"),
    };
    credentials::keep(origin, &next)?;
    Ok(next)
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

    /// The refresh, through the real keychain, against a door on a local
    /// port: the rotated pair is kept, and the refresh token the server
    /// sent replaces the one that was spent. Skipped where the keychain
    /// does not answer, as `credentials` skips.
    #[test]
    fn a_refresh_keeps_the_rotated_pair_and_sends_the_spent_token_once() {
        let _keychain = credentials::hold();
        let origin = format!("https://refresh.invalid:{}", std::process::id());
        let (endpoint, door) = token_door(
            "200 OK",
            r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer","scope":"*:read"}"#,
        );
        match credentials::keep(&origin, &stale_token(&endpoint)) {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                eprintln!("skipped: the keychain did not answer ({reason})");
                return;
            }
            Err(error) => panic!("{error}"),
        }
        let outcome = refresh(&origin, false);
        let _ = credentials::forget(&origin);
        let sent = door.received().remove(0);
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

    /// A door that refuses the refresh ends the sign-in: the entry is gone
    /// and the answer is "signed out", so the next command says so once.
    #[test]
    fn a_refused_refresh_forgets_the_entry_and_says_signed_out() {
        let _keychain = credentials::hold();
        let origin = format!("https://refused.invalid:{}", std::process::id());
        let (endpoint, door) = token_door(
            "400 Bad Request",
            r#"{"error":"invalid_grant","error_description":"revoked"}"#,
        );
        match credentials::keep(&origin, &stale_token(&endpoint)) {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                eprintln!("skipped: the keychain did not answer ({reason})");
                return;
            }
            Err(error) => panic!("{error}"),
        }
        let outcome = refresh(&origin, false);
        door.received();
        assert!(
            matches!(outcome, Err(CliError::SignedOut { .. })),
            "{outcome:?}"
        );
        assert_eq!(credentials::read(&origin).unwrap(), None);
    }
}
