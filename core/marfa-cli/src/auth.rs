use std::fs::File;
#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::path::PathBuf;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
#[cfg(unix)]
use sha2::{Digest, Sha256};
use url::Url;

use crate::credentials::{self, Kept};
use crate::error::CliError;
use crate::remote::Remote;
use crate::remote::request::Request;

pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

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

const REFRESH_AHEAD_SECONDS: u64 = 60;

#[derive(Debug, Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub token_endpoint: String,
    pub device_authorization_endpoint: String,
    pub registration_endpoint: String,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    /// Optional in RFC 8414.
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

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

/// The document is held to the origin it was read from (RFC 8414 section
/// 3.3): the binary is about to post a person's credential to what it names.
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

pub fn pages_on_issuer(discovery: &Discovery, code: &DeviceCode) -> Result<(), CliError> {
    on_issuer(discovery, &code.verification_uri)?;
    if let Some(complete) = &code.verification_uri_complete {
        on_issuer(discovery, complete)?;
    }
    Ok(())
}

/// Asks for everything the server supports: the consent screen narrows it,
/// and asking for less here would hide a toggle the person may want.
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

#[derive(Debug)]
pub enum Poll {
    Pending,
    SlowDown,
    Token(TokenSet),
}

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

pub fn wait_for_decision(
    discovery: &Discovery,
    client_id: &str,
    code: &DeviceCode,
) -> Result<TokenSet, CliError> {
    let deadline = now_seconds().saturating_add(code.expires_in);
    let mut interval = code.interval.max(1);
    loop {
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

/// The server revokes a chain whose rotated refresh token is replayed, so a
/// refresh is taken under a lock and the keychain re-read inside it: another
/// process may already have rotated the set, which is then the live one.
///
/// `refused` is the bearer a call was just answered `401` with: the refresh
/// happens only while it is still the kept one.
pub fn refresh(origin: &str, refused: Option<&str>) -> Result<Kept, CliError> {
    with_credential_lock(origin, || refresh_locked(origin, refused))
}

fn refresh_locked(origin: &str, refused: Option<&str>) -> Result<Kept, CliError> {
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
    // An answer on another contract is not read, which would leave the kept
    // refresh token spent with no new pair, so the root is checked first.
    Remote::public_at(origin)?.hold_root()?;
    let door = Remote::public_at(&token_endpoint)?;
    let answer = door.json(&Request::post(&[]).public().form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh_token),
        ("client_id", &client_id),
    ]));
    let token = match answer {
        Ok(value) => token_set(value)?,
        // Only a dead grant drops the token; a 429 or any other refusal
        // leaves it. The origin stays current so the next command names the
        // server and `marfa login`.
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
            // A server that does not rotate sends no refresh token.
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
        // The kept refresh token is spent and replaying it would revoke the
        // chain, so the entry goes.
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

/// The operation must not acquire this lock again, including by resolving a
/// credential that might need a refresh.
pub fn with_credential_lock<T>(
    origin: &str,
    operation: impl FnOnce() -> Result<T, CliError>,
) -> Result<T, CliError> {
    let mut lock = fd_lock::RwLock::new(credential_lock_file(origin)?);
    let _held = lock.write()?;
    operation()
}

#[cfg(unix)]
fn credential_lock_file(origin: &str) -> Result<File, CliError> {
    lock_file_in(&user_home()?.join(".marfa-credential-locks"), origin)
}

#[cfg(unix)]
fn user_home() -> Result<PathBuf, CliError> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut size = 1024;
    loop {
        let mut buffer = vec![0u8; size];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // The entry and buffer remain live until pw_dir has been copied.
        let status = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            size = size.checked_mul(2).ok_or_else(|| {
                CliError::Invalid("the operating-system user record is too large".into())
            })?;
            continue;
        }
        if status != 0 {
            return Err(std::io::Error::from_raw_os_error(status).into());
        }
        if result.is_null() {
            return Err(CliError::Invalid(
                "the operating-system user has no home directory".into(),
            ));
        }
        // A successful lookup populated the entry; pw_dir lives in buffer.
        let entry = unsafe { entry.assume_init() };
        if entry.pw_dir.is_null() {
            return Err(CliError::Invalid(
                "the operating-system user has no home directory".into(),
            ));
        }
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(unsafe {
            CStr::from_ptr(entry.pw_dir).to_bytes()
        }));
        if !home.is_absolute() {
            return Err(CliError::Invalid(
                "the operating-system user's home directory is not absolute".into(),
            ));
        }
        return Ok(home);
    }
}

#[cfg(unix)]
fn lock_file_in(dir: &std::path::Path, origin: &str) -> Result<File, CliError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    // Keep the checked directory open so a pathname replacement cannot
    // redirect the subsequent lock-file open.
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)?;
    let metadata = directory.metadata()?;
    // Safe: geteuid takes no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(CliError::Invalid(
            "the credential lock directory is not private to this user".into(),
        ));
    }
    let name = CString::new(format!("{}.lock", fingerprint(origin))).expect("hex name has no NUL");
    // openat pins the parent to the checked descriptor. NONBLOCK lets us
    // reject a planted FIFO instead of waiting on it before validation.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // The successful openat returned a new, owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(CliError::Invalid(
            "the credential lock is not a private regular file of this user".into(),
        ));
    }
    // Never unlink a lock file: a waiter can still hold its inode after
    // another process opens a replacement and takes a different lock.
    Ok(file)
}

#[cfg(not(unix))]
fn credential_lock_file(_: &str) -> Result<File, CliError> {
    Err(CliError::Invalid(
        "credential locking is not supported on this operating system".into(),
    ))
}

/// Revokes the refresh token where there is one, since that ends the whole
/// chain.
pub fn revoke(kept: &Kept) -> Result<bool, CliError> {
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
        return Ok(true);
    }
    Ok(false)
}

pub fn signed_out(origin: &str) -> CliError {
    CliError::SignedOut {
        origin: origin.to_string(),
    }
}

#[cfg(unix)]
fn fingerprint(origin: &str) -> String {
    format!("{:x}", Sha256::digest(origin.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door};

    fn token_door(status: &'static str, body: &str) -> (String, Door) {
        let root = format!(
            r#"{{"name":"marfa","contract":{}}}"#,
            marfa_client::CONTRACT_VERSION
        );
        let door = Door::open(vec![
            Answer::json("200 OK", &root),
            Answer::json(status, body),
        ]);
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

    fn closed_origin() -> String {
        let door = Door::open(vec![]);
        let origin = door.url.clone();
        door.received();
        origin
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

    #[test]
    fn a_refresh_keeps_the_rotated_pair_and_sends_the_spent_token_once() {
        let (endpoint, door) = token_door(
            "200 OK",
            r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer","scope":"*:read"}"#,
        );
        let origin = door.url.clone();
        let _keychain = credentials::hold(&origin);
        credentials::keep(&origin, &stale_token(&endpoint)).unwrap();
        let outcome = refresh(&origin, None);
        let received = door.received();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0].path(), "/");
        assert_eq!(received[0].header("authorization"), None);
        let sent = &received[1];
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

    #[test]
    fn a_set_already_rotated_by_another_process_is_not_refreshed_again() {
        let origin = format!("https://rotated.invalid:{}", std::process::id());
        let _keychain = credentials::hold(&origin);
        // Nothing listens here, so a refresh that should not happen fails.
        let endpoint = format!("{}/token", closed_origin());
        let fresh = token(
            &endpoint,
            Some(now_seconds() + 3600),
            Some("marfa_rt_fresh"),
        );
        credentials::keep(&origin, &fresh).unwrap();
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

    #[test]
    fn a_dead_grant_ends_the_sign_in_and_any_other_refusal_leaves_it() {
        let root = format!(
            r#"{{"name":"marfa","contract":{}}}"#,
            marfa_client::CONTRACT_VERSION
        );
        let door = Door::open(vec![
            Answer::json("200 OK", &root),
            Answer::json(
                "429 Too Many Requests",
                r#"{"error":{"code":"rate_limited","message":"slow down"}}"#,
            ),
            Answer::json("200 OK", &root),
            Answer::json(
                "400 Bad Request",
                r#"{"error":"invalid_grant","error_description":"revoked"}"#,
            ),
        ]);
        let endpoint = format!("{}/token", door.url);
        let origin = door.url.clone();
        let _keychain = credentials::hold(&origin);
        credentials::keep(&origin, &stale_token(&endpoint)).unwrap();
        let outcome = refresh(&origin, None);
        assert!(
            matches!(outcome, Err(CliError::Refused { status: 429, .. })),
            "{outcome:?}"
        );
        assert_eq!(
            credentials::read(&origin).unwrap(),
            Some(stale_token(&endpoint)),
            "a 429 is the server's answer to this call, not the end of the grant"
        );

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

#[cfg(all(test, unix))]
mod process_tests;
