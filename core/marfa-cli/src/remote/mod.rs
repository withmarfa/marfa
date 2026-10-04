pub mod request;

use std::fs::File;
use std::io::Read;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use marfa_core::contract::CONTRACT_VERSION;
use marfa_core::http::{Call, CallBody, Http, Renew, Reply, ReplyBody};
use marfa_core::{Core, CoreError, Server};
use serde_json::Value;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
#[cfg(test)]
use crate::error::Exit;
use request::{Body, Request};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialSource {
    Flag,
    Environment,
    Keychain,
}

impl CredentialSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialSource::Flag => "--key",
            CredentialSource::Environment => "MARFA_API_KEY",
            CredentialSource::Keychain => "keychain",
        }
    }
}

pub struct Remote {
    http: Http,
    url: String,
    origin: String,
    credential: Option<CredentialSource>,
    held: Arc<Held>,
}

/// How long a command waits for a server to answer, and to send an answer
/// whole. Some doors do their work before they answer: a restore, a bulk
/// write, a housekeeping job run on the spot.
const ANSWER_BUDGET: Duration = Duration::from_secs(90);

/// How long a streamed answer may stay silent before a read of it fails. The
/// event stream's keepalive comes well inside it, so a connection that has
/// dropped without a word ends the command instead of holding it.
const STREAM_IDLE: Duration = Duration::from_secs(45);

/// The credential in hand, which a renewal replaces while a command runs, so
/// what the command reports afterward is the credential that was sent last.
#[derive(Default)]
struct Held {
    bearer: Mutex<Option<String>>,
    kept: Mutex<Option<Kept>>,
}

impl Held {
    fn of(bearer: Option<String>, kept: Option<Kept>) -> Arc<Held> {
        Arc::new(Held {
            bearer: Mutex::new(bearer),
            kept: Mutex::new(kept),
        })
    }

    fn bearer(&self) -> Option<String> {
        lock(&self.bearer).clone()
    }

    fn kept(&self) -> Option<Kept> {
        lock(&self.kept).clone()
    }

    fn refreshable(&self) -> bool {
        matches!(
            &*lock(&self.kept),
            Some(Kept::Token {
                refresh_token: Some(_),
                ..
            })
        )
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Default, Clone)]
pub struct Named {
    pub url: Option<String>,
    pub key: Option<String>,
}

impl Named {
    pub fn session(&self) -> Result<Session, CliError> {
        let remote = Remote::resolve(self)?;
        let key = remote.bearer().ok_or_else(|| CliError::NoCredential {
            origin: remote.origin().to_string(),
        })?;
        Ok(Session {
            server: Server {
                url: remote.url().to_string(),
                key,
            },
            renew: renewal(&remote),
        })
    }

    pub fn session_if_named(&self) -> Result<Option<Session>, CliError> {
        match self.session() {
            Ok(session) => Ok(Some(session)),
            Err(CliError::NoServerNamed) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// A hydration, a push or a watch can outlive the signed-in token it started
/// with, so a session carries the way to renew it.
pub struct Session {
    pub server: Server,
    pub renew: Option<Renew>,
}

impl Session {
    pub fn split(session: Option<Session>) -> (Option<Server>, Option<Renew>) {
        match session {
            Some(Session { server, renew }) => (Some(server), renew),
            None => (None, None),
        }
    }
}

pub fn renewing(core: &Core, renew: Option<Renew>) {
    if let Some(renew) = renew {
        core.renew_credential_with(renew);
    }
}

/// Keyed by the bearer refused, so a token another process already rotated
/// is taken as it is rather than refreshed again. The one renewal path: the
/// command's own calls and a session's both go through it.
fn renewal(remote: &Remote) -> Option<Renew> {
    if !remote.held.refreshable() {
        return None;
    }
    let origin = remote.origin().to_string();
    let held = Arc::clone(&remote.held);
    Some(Box::new(move |refused: &str| {
        let kept = auth::refresh(&origin, Some(refused)).map_err(renewal_error)?;
        let bearer = kept.bearer().to_string();
        *lock(&held.bearer) = Some(bearer.clone());
        *lock(&held.kept) = Some(kept);
        Ok(bearer)
    }))
}

fn renewal_error(error: CliError) -> CoreError {
    match error {
        CliError::Core(core) => core,
        CliError::SignedOut { origin } => CoreError::SignedOut { origin },
        CliError::NoKeychain(reason) => CoreError::NoKeychain(reason),
        CliError::Io(error) => CoreError::Io(error.to_string()),
        CliError::Refused {
            status: 401,
            code,
            message,
            ..
        } => CoreError::Unauthorized { code, message },
        CliError::Refused {
            status: 429,
            code,
            message,
            retry_after_seconds,
            ..
        } => CoreError::RateLimited {
            code,
            message,
            retry_after_seconds,
        },
        CliError::Refused {
            status,
            code,
            message,
            ..
        } => CoreError::Server {
            status,
            code,
            message,
        },
        CliError::ContractMismatch {
            origin,
            served,
            expected,
            write_sent,
            status,
        } => CoreError::ContractMismatch {
            origin,
            served,
            expected,
            write_sent,
            status,
        },
        CliError::Redirected {
            origin,
            status,
            location,
        } => CoreError::Redirected {
            origin,
            status,
            location,
        },
        other => CoreError::Invalid(other.to_string()),
    }
}

impl Remote {
    pub fn resolve(named: &Named) -> Result<Remote, CliError> {
        let url = match named
            .url
            .clone()
            .or_else(|| non_empty(std::env::var("MARFA_API_URL").ok()))
        {
            Some(url) => url,
            // A keychain that cannot be asked means no server was named, whose
            // message says how to name one.
            None => match credentials::current() {
                Ok(Some(origin)) => origin,
                Ok(None) | Err(CliError::NoKeychain(_)) => return Err(CliError::NoServerNamed),
                Err(error) => return Err(error),
            },
        };
        let origin = marfa_core::http::origin_of(&url)?;
        let mut kept = None;
        let (key, credential) = match named.key.clone() {
            Some(key) => (Some(key), Some(CredentialSource::Flag)),
            None => match non_empty(std::env::var("MARFA_API_KEY").ok()) {
                Some(key) => (Some(key), Some(CredentialSource::Environment)),
                None => match auth::resolve_credential(&origin) {
                    Ok(Some(found)) => {
                        let bearer = found.bearer().to_string();
                        kept = Some(found);
                        (Some(bearer), Some(CredentialSource::Keychain))
                    }
                    Ok(None) => (None, None),
                    Err(error) => return Err(error),
                },
            },
        };
        Remote::keeping(&url, origin, credential, key, kept)
    }

    fn keeping(
        url: &str,
        origin: String,
        credential: Option<CredentialSource>,
        bearer: Option<String>,
        kept: Option<Kept>,
    ) -> Result<Remote, CliError> {
        let http = Http::with_timeouts(
            url,
            bearer.as_deref().unwrap_or_default(),
            ANSWER_BUDGET,
            ANSWER_BUDGET,
        )?;
        let remote = Remote {
            http,
            url: url.to_string(),
            origin,
            credential,
            held: Held::of(bearer, kept),
        };
        if let Some(renew) = renewal(&remote) {
            remote.http.renew_with(renew);
        }
        Ok(remote)
    }

    pub fn url_named(named: &Named) -> Result<String, CliError> {
        match named
            .url
            .clone()
            .or_else(|| non_empty(std::env::var("MARFA_API_URL").ok()))
        {
            Some(url) => Ok(url),
            None => match credentials::current() {
                Ok(Some(origin)) => Ok(origin),
                Ok(None) | Err(CliError::NoKeychain(_)) => Err(CliError::NoServerNamed),
                Err(error) => Err(error),
            },
        }
    }

    pub fn bearer(&self) -> Option<String> {
        self.held.bearer()
    }

    pub fn kept(&self) -> Option<Kept> {
        self.held.kept()
    }

    #[cfg(test)]
    pub(crate) fn holding(url: &str, kept: Kept) -> Result<Remote, CliError> {
        let origin = marfa_core::http::origin_of(url)?;
        Remote::keeping(
            url,
            origin,
            Some(CredentialSource::Keychain),
            Some(kept.bearer().to_string()),
            Some(kept),
        )
    }

    pub fn public_at(url: &str) -> Result<Remote, CliError> {
        let origin = marfa_core::http::origin_of(url)?;
        Remote::keeping(url, origin, None, None, None)
    }

    /// A key named outright, as a door that checks one wants it: a bootstrap
    /// secret, a key about to be kept, a token sent to its userinfo endpoint.
    pub fn keyed(url: &str, key: &str) -> Result<Remote, CliError> {
        let origin = marfa_core::http::origin_of(url)?;
        Remote::keeping(url, origin, None, Some(key.to_string()), None)
    }

    #[cfg(test)]
    pub fn with_http(http: Http, bearer: Option<&str>) -> Remote {
        let origin = http.origin();
        Remote {
            url: origin.clone(),
            http,
            origin,
            credential: None,
            held: Held::of(bearer.map(str::to_string), None),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn credential(&self) -> Option<CredentialSource> {
        self.credential
    }

    /// A refusal that names no contract is handed on, since a proxy in front
    /// of the server answers without one. An answer on another contract, and a
    /// redirect, are refused by the core's `Http`, as they are for the working
    /// copy, and a `401` to a kept token is renewed there too.
    pub fn call(&self, request: &Request) -> Result<Reply, CliError> {
        if request.mints {
            self.hold_root()?;
        }
        self.send(request, true)
    }

    /// For a write whose answer is the only copy of what it mints: an answer
    /// on another contract is not read, so the root is checked first.
    pub fn hold_root(&self) -> Result<(), CliError> {
        let instance = self.root()?;
        let served = instance.get("contract");
        if served.and_then(Value::as_u64) == Some(CONTRACT_VERSION) {
            return Ok(());
        }
        Err(CliError::ContractMismatch {
            origin: self.origin.clone(),
            served: served.map(|served| match served {
                Value::String(served) => served.clone(),
                other => other.to_string(),
            }),
            expected: CONTRACT_VERSION,
            write_sent: false,
            status: None,
        })
    }

    /// A file is opened afresh for each send, so one refused for an expired
    /// token is sent again once it has been renewed, as a JSON body is.
    fn send(&self, request: &Request, held: bool) -> Result<Reply, CliError> {
        let before = self.bearer();
        let reply = self.send_once(request, held)?;
        if matches!(request.body, Body::File { .. })
            && reply.status == 401
            && self.bearer() != before
        {
            return self.send_once(request, held);
        }
        Ok(reply)
    }

    fn send_once(&self, request: &Request, held: bool) -> Result<Reply, CliError> {
        if request.credential && self.bearer().is_none() {
            return Err(CliError::NoCredential {
                origin: self.origin.clone(),
            });
        }
        let segments: Vec<&str> = request.segments.iter().map(String::as_str).collect();
        let params: Vec<(&str, &str)> = request
            .query
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let mut headers: Vec<(&str, &str)> = request
            .headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let json_text;
        let form_text;
        let body = match &request.body {
            Body::None => CallBody::None,
            Body::Json(value) => {
                json_text = serde_json::to_string(value)?;
                CallBody::Json(&json_text)
            }
            Body::File { path, content_type } => {
                let file = File::open(path).map_err(|error| {
                    CliError::Invalid(format!("cannot read {}: {error}", path.display()))
                })?;
                headers.push(("Content-Type", content_type.as_str()));
                CallBody::Reader(Box::new(file))
            }
            Body::Form(pairs) => {
                form_text = url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs(
                        pairs
                            .iter()
                            .map(|(key, value)| (key.as_str(), value.as_str())),
                    )
                    .finish();
                headers.push(("Content-Type", "application/x-www-form-urlencoded"));
                CallBody::Text(&form_text)
            }
        };
        let reply = self
            .http
            .fetch(
                Call {
                    method: request.method,
                    segments: &segments,
                    params: &params,
                    headers: &headers,
                    body,
                    credential: request.credential,
                    stream: request.stream,
                },
                held,
            )
            .map_err(CliError::direct)?;
        if !(200..300).contains(&reply.status) && reply.contract.is_none() {
            return Err(CliError::Core(CoreError::Unnamed {
                origin: self.origin.clone(),
                status: reply.status,
                retry_after_seconds: reply.retry_after_seconds,
            }));
        }
        Ok(reply)
    }

    pub fn json(&self, request: &Request) -> Result<Value, CliError> {
        read_json(self.call(request)?, request)
    }

    /// `contract` is taken from the header, never the body: a body claiming
    /// the built-for contract must not let a command or a mint go on.
    pub fn root(&self) -> Result<Value, CliError> {
        let (mut instance, served) = self.describe(&crate::commands::status::root_request())?;
        if let Some(fields) = instance.as_object_mut() {
            match served {
                Some(served) => {
                    let value = match served.parse::<u64>() {
                        Ok(number) if number.to_string() == served => Value::from(number),
                        _ => Value::String(served),
                    };
                    fields.insert("contract".into(), value);
                }
                None => {
                    fields.remove("contract");
                }
            }
        }
        Ok(instance)
    }

    pub fn health(&self) -> Result<Value, CliError> {
        Ok(self.describe(&crate::commands::status::health_request())?.0)
    }

    /// The one read that skips the contract check, since the root and the
    /// health door are what say a server speaks another contract. Keep it
    /// private to them: any other door read this way would print an answer
    /// this binary cannot read.
    fn describe(&self, request: &Request) -> Result<(Value, Option<String>), CliError> {
        let reply = self.send(request, false)?;
        let served = reply.contract.clone();
        Ok((read_json(reply, request)?, served))
    }

    pub fn stream(&self, request: &Request) -> Result<(String, Box<dyn Read + Send>), CliError> {
        self.stream_within(request, STREAM_IDLE)
    }

    fn stream_within(
        &self,
        request: &Request,
        idle: Duration,
    ) -> Result<(String, Box<dyn Read + Send>), CliError> {
        let reply = self.call(request)?;
        match reply.body {
            ReplyBody::Stream(reader) => {
                Ok((reply.content_type, Box::new(Watched::new(reader, idle))))
            }
            ReplyBody::Text(text) => Err(refused(reply.status, &text, reply.retry_after_seconds)),
        }
    }
}

/// A reader whose reads fail once the source has said nothing for `idle`. The
/// HTTP client bounds a phase, not a silence, and a stream that is meant to
/// outlast any phase has none. The source is read on a thread of its own, left
/// behind when a read gives up on it.
struct Watched {
    chunks: mpsc::Receiver<std::io::Result<Vec<u8>>>,
    idle: Duration,
    held: Vec<u8>,
    at: usize,
}

impl Watched {
    fn new(mut source: Box<dyn Read + Send>, idle: Duration) -> Watched {
        let (sender, chunks) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let chunk = match source.read(&mut buffer) {
                    Ok(0) => Ok(Vec::new()),
                    Ok(n) => Ok(buffer[..n].to_vec()),
                    Err(error) => Err(error),
                };
                let last = !matches!(&chunk, Ok(bytes) if !bytes.is_empty());
                if sender.send(chunk).is_err() || last {
                    return;
                }
            }
        });
        Watched {
            chunks,
            idle,
            held: Vec::new(),
            at: 0,
        }
    }
}

impl Read for Watched {
    fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
        if self.at == self.held.len() {
            match self.chunks.recv_timeout(self.idle) {
                Ok(chunk) => {
                    self.held = chunk?;
                    self.at = 0;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "the server went silent",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = into.len().min(self.held.len() - self.at);
        into[..n].copy_from_slice(&self.held[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

fn read_json(reply: Reply, request: &Request) -> Result<Value, CliError> {
    let text = match reply.body {
        ReplyBody::Text(text) => text,
        ReplyBody::Stream(_) => {
            return Err(CliError::Invalid(format!(
                "{} was sent as a stream and read as JSON",
                request.path()
            )));
        }
    };
    if !(200..300).contains(&reply.status) {
        return Err(refused(reply.status, &text, reply.retry_after_seconds));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|error| {
        CliError::Core(marfa_core::CoreError::Decoding(format!(
            "{}: {error}",
            request.path()
        )))
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

#[derive(serde::Deserialize)]
struct Envelope {
    error: EnvelopeError,
}

#[derive(serde::Deserialize)]
struct EnvelopeError {
    code: String,
    message: Option<String>,
    details: Option<Value>,
}

pub fn refused(status: u16, text: &str, retry_after_seconds: Option<u64>) -> CliError {
    let (code, message, details) = match serde_json::from_str::<Envelope>(text) {
        Ok(envelope) => (
            envelope.error.code,
            envelope.error.message.unwrap_or_default(),
            envelope.error.details.map(Box::new),
        ),
        // The OAuth doors answer `{error, error_description}` rather than
        // the standard envelope.
        Err(_) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => (
                map.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                map.get("error_description")
                    .or_else(|| map.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                None,
            ),
            _ => (
                "unknown".to_string(),
                text.chars().take(200).collect(),
                None,
            ),
        },
    };
    CliError::Refused {
        status,
        code,
        message,
        retry_after_seconds,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::{Answer, Door, another_contract};

    fn remote_at(door: &Door, key: Option<&str>) -> Remote {
        match key {
            Some(key) => Remote::keyed(&door.url, key).unwrap(),
            None => Remote::public_at(&door.url).unwrap(),
        }
    }

    #[test]
    fn an_unnamed_gateway_refusal_is_environmental_for_json_and_streams() {
        for streamed in [false, true] {
            let answer = || {
                Answer::json(
                    "404 Not Found",
                    r#"{"error":{"code":"not_found","message":"gateway"}}"#,
                )
            };
            let door = Door::open(vec![answer(), answer().on_contract(None)]);
            let remote = remote_at(&door, Some("marfa_k1_x"));
            let request = Request::get(&["items"]);
            let refused = |request: &Request| {
                if streamed {
                    remote.stream(&request.clone().streamed()).err().unwrap()
                } else {
                    remote.json(request).unwrap_err()
                }
            };
            assert_eq!(refused(&request).code(), "not_found");
            let error = refused(&request);
            assert_eq!(error.code(), "unnamed_answer");
            assert_eq!(error.exit(), Exit::Environment);
            assert_eq!(error.envelope()["error"]["server"]["status"], 404);
            assert!(error.envelope()["error"]["server"]["code"].is_null());
            door.received();
        }
    }

    #[test]
    fn renewal_adapter_preserves_refusal_and_local_provenance() {
        for status in [None, Some(200)] {
            let error = CliError::ContractMismatch {
                origin: "https://marfa.example".into(),
                served: Some("other".into()),
                expected: 1,
                write_sent: false,
                status,
            };
            let expected = error.envelope();
            let crossed = CliError::from(CoreError::RenewalFailed(Box::new(renewal_error(error))));
            assert_eq!(crossed.envelope(), expected);
        }
        let errors = [
            CliError::Redirected {
                origin: "https://marfa.example".into(),
                status: 302,
                location: Some("/other".into()),
            },
            CliError::Invalid("unsafe credential lock".into()),
            CliError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            CliError::Core(CoreError::Decoding("malformed token".into())),
            CliError::Refused {
                status: 400,
                code: "invalid_scope".into(),
                message: "refused scope".into(),
                retry_after_seconds: None,
                details: None,
            },
        ];
        for error in errors {
            let expected = error.envelope();
            let crossed = CliError::from(CoreError::RenewalFailed(Box::new(renewal_error(error))));
            assert_eq!(crossed.envelope(), expected);
        }
    }

    #[test]
    fn renewal_adapter_preserves_local_credential_failures() {
        for (error, code, exit) in [
            (
                CliError::SignedOut {
                    origin: "https://marfa.example".into(),
                },
                "signed_out",
                Exit::Credential,
            ),
            (
                CliError::NoKeychain("locked".into()),
                "no_keychain",
                Exit::Local,
            ),
        ] {
            let crossed = CliError::from(renewal_error(error));
            assert_eq!(crossed.code(), code);
            assert_eq!(crossed.exit(), exit);
            assert!(crossed.envelope()["error"]["server"].is_null());
        }
    }

    #[test]
    fn a_refusal_keeps_the_envelope_and_reads_the_oauth_shape_too() {
        match refused(
            422,
            r#"{"error":{"code":"bulk_atomic_rollback","message":"entry 3","details":{"index":3}}}"#,
            None,
        ) {
            CliError::Refused {
                status,
                code,
                message,
                details,
                ..
            } => {
                assert_eq!(
                    (status, code.as_str(), message.as_str()),
                    (422, "bulk_atomic_rollback", "entry 3")
                );
                assert_eq!(details.unwrap()["index"], 3);
            }
            other => panic!("{other:?}"),
        }
        match refused(
            400,
            r#"{"error":"invalid_grant","error_description":"revoked"}"#,
            None,
        ) {
            CliError::Refused { code, message, .. } => {
                assert_eq!(
                    (code.as_str(), message.as_str()),
                    ("invalid_grant", "revoked")
                );
            }
            other => panic!("{other:?}"),
        }
        match refused(502, "<html>bad gateway</html>", Some(3)) {
            CliError::Refused {
                code,
                message,
                retry_after_seconds,
                ..
            } => {
                assert_eq!(code, "unknown");
                assert_eq!(message, "<html>bad gateway</html>");
                assert_eq!(retry_after_seconds, Some(3));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_credential_rides_only_where_the_door_needs_it() {
        let door = Door::open(vec![
            Answer::json("200 OK", r#"{"name":"marfa"}"#),
            Answer::json("200 OK", r#"{"data":[]}"#),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        remote.json(&Request::get(&[]).public()).unwrap();
        remote.json(&Request::get(&["items"])).unwrap();
        let received = door.received();
        assert_eq!(received[0].path(), "/");
        assert_eq!(received[0].header("authorization"), None);
        assert_eq!(received[0].header("accept"), Some("application/json"));
        assert_eq!(received[1].path(), "/items");
        assert_eq!(
            received[1].header("authorization"),
            Some("Bearer marfa_k1_x")
        );
    }

    #[test]
    fn a_call_with_no_credential_is_refused_before_it_is_sent() {
        let door = Door::open(vec![]);
        let remote = remote_at(&door, None);
        assert!(matches!(
            remote.json(&Request::get(&["items"])),
            Err(CliError::NoCredential { .. })
        ));
        assert!(door.received().is_empty());
    }

    #[test]
    fn a_refused_kept_token_is_refreshed_once_and_the_call_sent_again() {
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            root(&marfa_core::contract::CONTRACT_VERSION.to_string()),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Answer::json("200 OK", r#"{"data":[]}"#),
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"still"}}"#,
            ),
            root(&marfa_core::contract::CONTRACT_VERSION.to_string()),
            Answer::json(
                "429 Too Many Requests",
                r#"{"error":{"code":"rate_limited","message":"slow down"}}"#,
            ),
        ]);
        let kept = Kept::Token {
            access_token: "marfa_at_old".into(),
            refresh_token: Some("marfa_rt_old".into()),
            expires_at: Some(crate::auth::now_seconds() + 3600),
            client_id: "client".into(),
            scope: None,
            token_endpoint: format!("{}/auth/oauth2/token", door.url),
            revocation_endpoint: None,
        };
        let origin = marfa_core::http::origin_of(&door.url).unwrap();
        let _keychain = credentials::hold(&origin);
        credentials::keep(&origin, &kept).unwrap();
        let remote = Remote::holding(&door.url, kept).unwrap();
        let listed = remote.json(&Request::get(&["items"])).unwrap();
        assert_eq!(listed["data"], serde_json::json!([]));
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::Refused { status: 429, .. }) => {}
            other => panic!("{:?}", other.map(|_| ())),
        }
        assert!(
            matches!(credentials::read(&origin).unwrap(), Some(Kept::Token { access_token, .. }) if access_token == "marfa_at_new"),
            "the rotated set is the kept one, and the refused refresh left it"
        );
        let received = door.received();
        let paths: Vec<&str> = received.iter().map(|r| r.path()).collect();
        // The root is read before each refresh: the token answer is the only
        // copy of the rotated pair.
        assert_eq!(
            paths,
            vec![
                "/items",
                "/",
                "/auth/oauth2/token",
                "/items",
                "/items",
                "/",
                "/auth/oauth2/token"
            ]
        );
        assert_eq!(
            received[0].header("authorization"),
            Some("Bearer marfa_at_old")
        );
        assert!(
            received[2].body.contains("refresh_token=marfa_rt_old"),
            "{}",
            received[2].body
        );
        assert_eq!(
            received[3].header("authorization"),
            Some("Bearer marfa_at_new")
        );
        assert!(
            received[6].body.contains("refresh_token=marfa_rt_new"),
            "{}",
            received[6].body
        );
    }

    #[test]
    fn a_copy_opened_with_a_session_renews_its_refused_token_and_goes_on() {
        const HASH: &str =
            "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        let door = Door::open_at(|url| {
            vec![
                Answer::json(
                    "401 Unauthorized",
                    r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
                ),
                root(&marfa_core::contract::CONTRACT_VERSION.to_string()),
                Answer::json(
                    "200 OK",
                    r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
                ),
                Answer::json("200 OK", &format!(r#"{{"url":"{url}/bytes"}}"#)),
                Answer::json("200 OK", "hello"),
            ]
        });
        let kept = Kept::Token {
            access_token: "marfa_at_old".into(),
            refresh_token: Some("marfa_rt_old".into()),
            expires_at: Some(crate::auth::now_seconds() + 3600),
            client_id: "client".into(),
            scope: None,
            token_endpoint: format!("{}/auth/oauth2/token", door.url),
            revocation_endpoint: None,
        };
        let origin = marfa_core::http::origin_of(&door.url).unwrap();
        let _keychain = credentials::hold(&origin);
        credentials::keep(&origin, &kept).unwrap();
        let remote = Remote::holding(&door.url, kept).unwrap();
        let dir = std::env::temp_dir().join(format!(
            "marfa-session-{}-{}",
            std::process::id(),
            crate::auth::now_seconds()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let core = Core::open(
            dir.join("copy.sqlite"),
            Some(Server {
                url: door.url.clone(),
                key: "marfa_at_old".into(),
            }),
        )
        .unwrap();
        renewing(&core, renewal(&remote));
        assert!(renewal(&remote_at(&door, Some("marfa_k1_x"))).is_none());

        let held = core.blob(HASH).unwrap();

        assert_eq!(std::fs::read(held).unwrap(), b"hello");
        let received = door.received();
        let paths: Vec<&str> = received.iter().map(|r| r.path()).collect();
        let link = format!("/blobs/{HASH}/url");
        assert_eq!(
            paths,
            vec![&link, "/", "/auth/oauth2/token", &link, "/bytes"]
        );
        assert_eq!(
            received[0].header("authorization"),
            Some("Bearer marfa_at_old")
        );
        assert!(
            received[2].body.contains("refresh_token=marfa_rt_old"),
            "{}",
            received[2].body
        );
        assert_eq!(
            received[3].header("authorization"),
            Some("Bearer marfa_at_new")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_call_sent_again_after_a_refresh_is_held_to_the_contract() {
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            root(&marfa_core::contract::CONTRACT_VERSION.to_string()),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Answer::json("200 OK", PAGE).on_another_contract(),
        ]);
        let kept = Kept::Token {
            access_token: "marfa_at_old".into(),
            refresh_token: Some("marfa_rt_old".into()),
            expires_at: Some(crate::auth::now_seconds() + 3600),
            client_id: "client".into(),
            scope: None,
            token_endpoint: format!("{}/auth/oauth2/token", door.url),
            revocation_endpoint: None,
        };
        let origin = marfa_core::http::origin_of(&door.url).unwrap();
        let _keychain = credentials::hold(&origin);
        credentials::keep(&origin, &kept).unwrap();
        let remote = Remote::holding(&door.url, kept).unwrap();
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::ContractMismatch { served, .. }) => {
                assert_eq!(served, Some(another_contract()));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(door.received().len(), 4);
    }

    #[test]
    fn a_refusal_and_an_empty_success_are_read_as_what_they_are() {
        let door = Door::open(vec![
            Answer::json(
                "409 Conflict",
                r#"{"error":{"code":"version_conflict","message":"moved","details":{"version":3}}}"#,
            ),
            Answer::json("204 No Content", ""),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        match remote.json(&Request::patch(&["items", "i"]).json(serde_json::json!({}))) {
            Err(CliError::Refused {
                status,
                code,
                details,
                ..
            }) => {
                assert_eq!((status, code.as_str()), (409, "version_conflict"));
                assert_eq!(details.unwrap()["version"], 3);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            remote.json(&Request::delete(&["items", "i"])).unwrap(),
            Value::Null
        );
        let received = door.received();
        assert_eq!(received[0].header("content-type"), Some("application/json"));
        assert_eq!(received[0].body, "{}");
    }

    #[test]
    fn a_stream_is_a_reader_on_success_and_a_refusal_otherwise() {
        let door = Door::open(vec![
            Answer {
                status: "200 OK",
                content_type: "text/plain",
                body: "hello".into(),
                headers: Vec::new(),
            }
            .on_contract(Some(&marfa_core::contract::CONTRACT_VERSION.to_string())),
            Answer::json(
                "404 Not Found",
                r#"{"error":{"code":"blob_not_found","message":"no such blob"}}"#,
            ),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        let (content_type, mut reader) = remote
            .stream(&Request::get(&["blobs", "sha256:a"]).streamed())
            .unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(
            (content_type.as_str(), text.as_str()),
            ("text/plain", "hello")
        );
        match remote.stream(&Request::get(&["blobs", "sha256:b"]).streamed()) {
            Err(CliError::Refused { status, code, .. }) => {
                assert_eq!((status, code.as_str()), (404, "blob_not_found"));
            }
            other => panic!("{:?}", other.map(|_| ())),
        }
        let received = door.received();
        assert_eq!(received[0].header("accept"), Some("*/*"));
    }

    #[test]
    fn a_file_body_carries_its_type_once_and_its_bytes_whole() {
        let dir = std::env::temp_dir().join(format!("marfa-remote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bytes.bin");
        std::fs::write(&path, b"PNG raw bytes").unwrap();
        let door = Door::open(vec![Answer::json("201 Created", r#"{"hash":"sha256:h"}"#)]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        remote
            .json(&Request::post(&["blobs"]).file(path, "image/png"))
            .unwrap();
        let received = door.received();
        let types: Vec<&str> = received[0]
            .headers
            .iter()
            .filter(|(name, _)| name == "content-type")
            .map(|(_, value)| value.as_str())
            .collect();
        assert_eq!(types, vec!["image/png"]);
        assert_eq!(received[0].body, "PNG raw bytes");
    }

    #[test]
    fn a_file_refused_for_an_expired_token_is_sent_again_once_renewed() {
        let dir = std::env::temp_dir().join(format!("marfa-resend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bytes.bin");
        std::fs::write(&path, b"PNG raw bytes").unwrap();
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            Answer::json("201 Created", r#"{"hash":"sha256:h"}"#),
        ]);
        let remote = Remote::with_http(
            Http::new(&door.url, "marfa_at_old").unwrap(),
            Some("marfa_at_old"),
        );
        let held = Arc::clone(&remote.held);
        remote.http.renew_with(Box::new(move |_| {
            *lock(&held.bearer) = Some("marfa_at_new".into());
            Ok("marfa_at_new".into())
        }));
        remote
            .json(&Request::post(&["blobs"]).file(path, "image/png"))
            .unwrap();
        let received = door.received();
        let sent: Vec<(&str, &str)> = received
            .iter()
            .map(|request| {
                let bearer = request
                    .headers
                    .iter()
                    .find(|(name, _)| name == "authorization")
                    .map_or("", |(_, value)| value.as_str());
                (bearer, request.body.as_str())
            })
            .collect();
        assert_eq!(
            sent,
            vec![
                ("Bearer marfa_at_old", "PNG raw bytes"),
                ("Bearer marfa_at_new", "PNG raw bytes"),
            ]
        );
    }

    #[test]
    fn a_stream_gone_silent_fails_a_read_and_one_with_gaps_does_not() {
        let silent = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            std::thread::spawn(move || {
                if let Ok((mut socket, _)) = listener.accept() {
                    let mut chunk = [0u8; 4096];
                    let _ = Read::read(&mut socket, &mut chunk);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{}: {}\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n:\n\n\r\n",
                        marfa_core::http::CONTRACT_HEADER,
                        marfa_core::contract::CONTRACT_VERSION,
                    );
                    let _ = std::io::Write::write_all(&mut socket, head.as_bytes());
                    std::thread::sleep(Duration::from_secs(10));
                }
            });
            url
        };
        let (_, mut reader) = Remote::with_http(
            Http::new(&silent, "marfa_k1_x").unwrap(),
            Some("marfa_k1_x"),
        )
        .stream_within(
            &Request::get(&["events"]).streamed(),
            Duration::from_millis(400),
        )
        .unwrap();
        let mut first = [0u8; 3];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(&first, b":\n\n");
        let error = reader.read(&mut first).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        // The witness: a source that pauses for less than the limit between
        // bytes is read to its end.
        let (_, mut reader) = Remote::with_http(
            Http::new(&trickling(true), "marfa_k1_x").unwrap(),
            Some("marfa_k1_x"),
        )
        .stream_within(
            &Request::get(&["export"]).streamed(),
            Duration::from_millis(700),
        )
        .unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "0123456789");
    }

    fn root(contract: &str) -> Answer {
        Answer::json(
            "200 OK",
            &format!(r#"{{"name":"marfa","version":"dev","contract":{contract},"features":[]}}"#),
        )
    }

    const PAGE: &str = r#"{"data":[],"next_cursor":null}"#;

    #[test]
    fn a_root_that_refuses_is_that_refusal() {
        let door = Door::open(vec![
            Answer::json(
                "404 Not Found",
                r#"{"error":{"code":"not_found","message":"no"}}"#,
            ),
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"sign in"}}"#,
            )
            .on_contract(None),
        ]);
        assert!(matches!(
            remote_at(&door, Some("marfa_k1_x")).root(),
            Err(CliError::Refused { status: 404, .. })
        ));
        assert!(matches!(
            remote_at(&door, Some("marfa_k1_x")).root(),
            Err(CliError::Core(CoreError::Unnamed { status: 401, .. }))
        ));
        door.received();
    }

    #[test]
    fn a_read_refused_on_another_contract_says_no_write_was_sent() {
        let door = Door::open(vec![Answer::json("200 OK", PAGE).on_another_contract()]);
        match remote_at(&door, Some("marfa_k1_x")).json(&Request::get(&["items"])) {
            Err(
                error @ CliError::ContractMismatch {
                    write_sent: false, ..
                },
            ) => {
                assert!(
                    !error.to_string().contains("may have taken effect"),
                    "{error}"
                );
                assert_eq!(error.envelope()["error"]["server"]["status"], 200);
                assert!(error.envelope()["error"]["server"]["code"].is_null());
            }
            other => panic!("{other:?}"),
        }
        door.received();
    }

    #[test]
    fn a_write_answered_on_another_contract_says_it_was_sent() {
        let door = Door::open(vec![
            Answer::json("201 Created", r#"{"item":{"id":"i"}}"#).on_another_contract(),
        ]);
        match remote_at(&door, Some("marfa_k1_x"))
            .json(&Request::post(&["items"]).json(serde_json::json!({})))
        {
            Err(
                error @ CliError::ContractMismatch {
                    write_sent: true, ..
                },
            ) => assert!(
                error.to_string().contains("may have taken effect"),
                "{error}"
            ),
            other => panic!("{other:?}"),
        }
        door.received();
    }

    #[test]
    fn the_body_of_an_answer_on_another_contract_is_not_read() {
        let door = Door::open(vec![
            Answer::json("200 OK", PAGE).on_another_contract(),
            Answer::json("200 OK", PAGE).on_another_contract(),
        ]);
        let http = Http::new(&door.url, "marfa_k1_x").unwrap();
        let call = || Call {
            method: request::Method::Get,
            segments: &["items"],
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        };
        assert!(matches!(
            http.fetch(call(), true),
            Err(CoreError::ContractMismatch {
                write_sent: false,
                ..
            })
        ));
        // The witness: the same answer, not held, is read.
        match http.fetch(call(), false).unwrap().body {
            ReplyBody::Text(text) => assert_eq!(text, PAGE),
            ReplyBody::Stream(_) => panic!("a stream"),
        }
        door.received();
    }

    #[test]
    fn a_redirect_is_not_followed() {
        let door = Door::open(vec![
            Answer::json("302 Found", "").with_header("Location", "/elsewhere"),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        match remote.json(&Request::get(&["items"])) {
            Err(error @ CliError::Redirected { status: 302, .. }) => {
                assert_eq!(error.code(), "redirect");
                assert!(error.to_string().contains("/elsewhere"), "{error}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(door.received().len(), 1);
    }

    #[test]
    fn retry_after_is_read_in_both_forms() {
        let door = Door::open(vec![
            Answer::json(
                "429 Too Many Requests",
                r#"{"error":{"code":"rate_limited","message":"slow"}}"#,
            )
            .with_header("Retry-After", "7"),
            Answer::json(
                "503 Service Unavailable",
                r#"{"error":{"code":"write_contention","message":"busy"}}"#,
            )
            .with_header("Retry-After", "Sun, 06 Nov 1994 08:49:42 GMT")
            .with_header("Date", "Sun, 06 Nov 1994 08:49:37 GMT"),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        for expected in [7, 5] {
            match remote.json(&Request::get(&["items"])) {
                Err(CliError::Refused {
                    retry_after_seconds,
                    ..
                }) => assert_eq!(retry_after_seconds, Some(expected)),
                other => panic!("{other:?}"),
            }
        }
        door.received();
    }

    #[test]
    fn a_named_header_reaches_the_wire() {
        let door = Door::open(vec![Answer::json("200 OK", r#"{"data":[]}"#)]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        remote
            .json(&Request::get(&["items"]).header("Last-Event-ID", "42"))
            .unwrap();
        assert_eq!(door.received()[0].header("last-event-id"), Some("42"));
    }

    #[test]
    fn a_root_refusing_for_another_reason_is_that_refusal() {
        let door = Door::open(vec![
            Answer::json(
                "503 Service Unavailable",
                r#"{"error":{"code":"write_contention","message":"busy"}}"#,
            )
            .with_header("Retry-After", "7"),
        ]);
        match remote_at(&door, Some("marfa_k1_x")).root() {
            Err(CliError::Refused {
                status,
                code,
                retry_after_seconds,
                ..
            }) => {
                assert_eq!((status, code.as_str()), (503, "write_contention"));
                assert_eq!(retry_after_seconds, Some(7));
            }
            other => panic!("{other:?}"),
        }
        door.received();
    }

    #[test]
    fn a_root_that_redirects_is_refused_as_one() {
        let door = Door::open(vec![
            Answer::json("301 Moved Permanently", "")
                .with_header("Location", "https://marfa.example/"),
        ]);
        match remote_at(&door, Some("marfa_k1_x")).root() {
            Err(CliError::Redirected {
                status, location, ..
            }) => {
                assert_eq!(status, 301);
                assert_eq!(location.as_deref(), Some("https://marfa.example/"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(door.received().len(), 1);
    }

    /// Sends its answer a byte at a time: each inside the read budget, the
    /// whole outside the whole-answer budget.
    fn trickling(stream: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut stream_to, _)) = listener.accept() {
                let mut chunk = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream_to, &mut chunk);
                let body = "0123456789";
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    if stream {
                        "text/plain"
                    } else {
                        "application/json"
                    },
                    marfa_core::http::CONTRACT_HEADER,
                    marfa_core::contract::CONTRACT_VERSION,
                    body.len()
                );
                let _ = std::io::Write::write_all(&mut stream_to, head.as_bytes());
                for byte in body.bytes() {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    let _ = std::io::Write::write_all(&mut stream_to, &[byte]);
                }
            }
        });
        url
    }

    fn budgeted(url: &str, read_ms: u64, whole_ms: u64) -> Remote {
        Remote::with_http(
            Http::with_timeouts(
                url,
                "marfa_k1_x",
                std::time::Duration::from_millis(read_ms),
                std::time::Duration::from_millis(whole_ms),
            )
            .unwrap(),
            Some("marfa_k1_x"),
        )
    }

    #[test]
    fn a_json_answer_is_bounded_as_a_whole() {
        match budgeted(&trickling(false), 2_000, 600).json(&Request::get(&["items"])) {
            Err(CliError::Core(marfa_core::CoreError::Network(_))) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_stream_outlasts_the_whole_answer_budget() {
        let (_, mut reader) = budgeted(&trickling(true), 2_000, 600)
            .stream(&Request::get(&["export"]).streamed())
            .unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "0123456789");
    }

    #[test]
    fn a_server_that_never_answers_is_given_up_on() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for _ in 0..2 {
                held.push(listener.accept());
            }
            std::thread::sleep(std::time::Duration::from_secs(10));
            drop(held);
        });
        let started = std::time::Instant::now();
        match budgeted(&url, 500, 60_000).stream(&Request::get(&["export"]).streamed()) {
            Err(CliError::Core(marfa_core::CoreError::Network(_))) => {}
            other => panic!("{:?}", other.map(|_| ())),
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn a_transport_failure_carries_its_cause() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let remote = Remote::keyed(&format!("http://127.0.0.1:{port}"), "marfa_k1_x").unwrap();
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::Core(marfa_core::CoreError::Network(text))) => {
                assert!(text.to_lowercase().contains("refused"), "{text}");
            }
            other => panic!("{other:?}"),
        }
    }

    // The witness, on the server's own contract, is `cli/login.test.ts`.
    #[test]
    fn whoami_on_another_contract_names_no_person() {
        let door = Door::open(vec![root(&another_contract()).on_another_contract()]);
        let kept = Kept::Token {
            access_token: "marfa_at_x".into(),
            refresh_token: None,
            expires_at: None,
            client_id: "c".into(),
            scope: Some("openid".into()),
            token_endpoint: format!("{}/auth/oauth2/token", door.url),
            revocation_endpoint: None,
        };
        let remote = Remote::holding(&door.url, kept).unwrap();
        crate::commands::whoami::run(&remote, &crate::output::Printer { json: true }).unwrap();
        let received = door.received();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].path(), "/");
        assert_eq!(received[0].header("authorization"), None);
    }
}
