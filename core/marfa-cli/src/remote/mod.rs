//! The server a direct command talks to, and how it talks to it.

pub mod request;
pub mod transport;

use std::cell::RefCell;
use std::fs::File;
use std::io::Read;

use marfa_core::Server;
use marfa_core::http::{Call, CallBody, Reply, ReplyBody};
use serde_json::Value;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
use request::{Body, Request};
pub use transport::Transport;

/// Where the credential a call carries came from, for `whoami` to say.
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
    /// Rebuilt when a kept token is refreshed mid-command.
    http: RefCell<Transport>,
    url: String,
    origin: String,
    credential: Option<CredentialSource>,
    bearer: RefCell<Option<String>>,
    /// The keychain entry the credential came from, when it did, so a
    /// token can be refreshed and `whoami` can say what was granted.
    kept: RefCell<Option<Kept>>,
}

/// The two values the command line and the environment can name.
#[derive(Debug, Default, Clone)]
pub struct Named {
    pub url: Option<String>,
    pub key: Option<String>,
}

impl Named {
    /// What a command that sends from the working copy needs: the server
    /// and the credential, resolved the same way a direct command's are,
    /// so a kept key or a sign-in reaches `device` and `folders` too.
    pub fn server(&self) -> Result<Server, CliError> {
        let remote = Remote::resolve(self)?;
        let key = remote.bearer().ok_or_else(|| CliError::NoCredential {
            origin: remote.origin().to_string(),
        })?;
        Ok(Server {
            url: remote.url().to_string(),
            key,
        })
    }
}

impl Remote {
    /// Resolves the server and the credential: the flag, then the
    /// environment, then the keychain, in that order for each, and never a
    /// file.
    pub fn resolve(named: &Named) -> Result<Remote, CliError> {
        let url = match named
            .url
            .clone()
            .or_else(|| non_empty(std::env::var("MARFA_API_URL").ok()))
        {
            Some(url) => url,
            // The origin a sign-in or a kept key made current. A keychain
            // that cannot be asked is not an error here: the flag and the
            // environment were empty, so the answer is that no server was
            // named, and the message says how to name one.
            None => match credentials::current() {
                Ok(Some(origin)) => origin,
                Ok(None) | Err(CliError::NoKeychain(_)) => return Err(CliError::NoServerNamed),
                Err(error) => return Err(error),
            },
        };
        let origin = transport::origin_of(&url)?;
        let mut kept = None;
        let (key, credential) = match named.key.clone() {
            Some(key) => (Some(key), Some(CredentialSource::Flag)),
            None => match non_empty(std::env::var("MARFA_API_KEY").ok()) {
                Some(key) => (Some(key), Some(CredentialSource::Environment)),
                None => match credentials::read(&origin) {
                    Ok(Some(found)) => {
                        // A token about to expire is refreshed before the
                        // call rather than after its refusal.
                        let found = if auth::is_stale(&found) {
                            auth::refresh(&origin, None)?
                        } else {
                            found
                        };
                        let bearer = found.bearer().to_string();
                        kept = Some(found);
                        (Some(bearer), Some(CredentialSource::Keychain))
                    }
                    Ok(None) | Err(CliError::NoKeychain(_)) => (None, None),
                    Err(error) => return Err(error),
                },
            },
        };
        let http = Transport::new(&url, key.as_deref())?;
        Ok(Remote {
            http: RefCell::new(http),
            url,
            origin,
            credential,
            bearer: RefCell::new(key),
            kept: RefCell::new(kept),
        })
    }

    /// The server as named, without a credential: what `login` starts from.
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

    /// The credential's bearer value, for keeping it.
    pub fn bearer(&self) -> Option<String> {
        self.bearer.borrow().clone()
    }

    /// The keychain entry the credential came from, if it did.
    pub fn kept(&self) -> Option<Kept> {
        self.kept.borrow().clone()
    }

    /// Whether a `401` can be answered by refreshing: only a kept token can.
    fn can_refresh(&self) -> bool {
        matches!(
            &*self.kept.borrow(),
            Some(Kept::Token {
                refresh_token: Some(_),
                ..
            })
        )
    }

    /// Refreshes the kept token after a `401` and rebuilds the transport
    /// with the new one.
    fn refreshed(&self) -> Result<(), CliError> {
        let refused = self.bearer.borrow().clone().unwrap_or_default();
        let next = auth::refresh(&self.origin, Some(&refused))?;
        let bearer = next.bearer().to_string();
        *self.http.borrow_mut() = Transport::new(&self.url, Some(&bearer))?;
        *self.bearer.borrow_mut() = Some(bearer);
        *self.kept.borrow_mut() = Some(next);
        Ok(())
    }

    /// A remote holding a keychain entry, for the tests of the refresh
    /// path, which `resolve` reaches only through the real keychain.
    #[cfg(test)]
    pub(crate) fn holding(url: &str, kept: Kept) -> Result<Remote, CliError> {
        let http = Transport::new(url, Some(kept.bearer()))?;
        let origin = http.origin();
        Ok(Remote {
            url: url.to_string(),
            http: RefCell::new(http),
            origin,
            credential: Some(CredentialSource::Keychain),
            bearer: RefCell::new(Some(kept.bearer().to_string())),
            kept: RefCell::new(Some(kept)),
        })
    }

    /// A remote at a URL with no credential: the sign-in surface's doors,
    /// which take a client id or a token in the body rather than a bearer.
    pub fn public_at(url: &str) -> Result<Remote, CliError> {
        let http = Transport::new(url, None)?;
        let origin = http.origin();
        Ok(Remote {
            url: url.to_string(),
            http: RefCell::new(http),
            origin,
            credential: None,
            bearer: RefCell::new(None),
            kept: RefCell::new(None),
        })
    }

    /// A remote over a transport built for one call, such as the bootstrap
    /// mint, which carries the printed secret rather than a key, so it
    /// names no credential source.
    pub fn with(http: Transport) -> Remote {
        let origin = http.origin();
        Remote {
            url: origin.clone(),
            http: RefCell::new(http),
            origin,
            credential: None,
            bearer: RefCell::new(None),
            kept: RefCell::new(None),
        }
    }

    /// The server as it was named, for building a second transport to it.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn credential(&self) -> Option<CredentialSource> {
        self.credential
    }

    /// Sends a request. Every status the server answers is a `Reply`; an
    /// `Err` is a transport failure, a missing credential, or a refresh
    /// that could not be made.
    ///
    /// An answer that names another contract, or a success that names none,
    /// is refused before anything reads it: its body may be shaped in ways
    /// this binary cannot read. A refusal that names none is handed on,
    /// since a proxy in front of the server answers without one.
    ///
    /// A `401` to a kept token is answered by one refresh and one retry,
    /// because the token may have been rotated by another process since
    /// this one read the keychain, or have run out between the read and
    /// the call.
    pub fn call(&self, request: &Request) -> Result<Reply, CliError> {
        if request.mints {
            self.hold_root()?;
        }
        let reply = self.checked(self.send(request, true)?, request)?;
        if reply.status == 401 && request.credential && self.can_refresh() {
            self.refreshed()?;
            return self.checked(self.send(request, true)?, request);
        }
        Ok(reply)
    }

    fn checked(&self, reply: Reply, request: &Request) -> Result<Reply, CliError> {
        if transport::speaks_this_contract(reply.contract.as_deref(), reply.status) {
            return Ok(reply);
        }
        Err(CliError::ContractMismatch {
            origin: self.origin.clone(),
            served: match reply.contract {
                Some(served) => format!("answers contract {served}"),
                None => format!("answered {} naming no contract", reply.status),
            },
            expected: marfa_client::CONTRACT_VERSION,
            // The answer is what names the contract, so it arrives after the
            // server has acted on the request.
            write_sent: request.method != request::Method::Get,
            status: Some(reply.status),
        })
    }

    /// Reads the root and refuses a server on another contract before
    /// anything is sent to it: for a write whose answer is the only copy of
    /// what it mints (`Request::minting`).
    pub fn hold_root(&self) -> Result<(), CliError> {
        let instance = self.root()?;
        let served = instance.get("contract");
        if served.and_then(Value::as_u64) == Some(marfa_client::CONTRACT_VERSION) {
            return Ok(());
        }
        Err(CliError::ContractMismatch {
            origin: self.origin.clone(),
            served: match served {
                Some(served) => format!("answers contract {served}"),
                None => "answers no contract at its root".into(),
            },
            expected: marfa_client::CONTRACT_VERSION,
            write_sent: false,
            status: None,
        })
    }

    fn redirected(&self, reply: &Reply) -> Option<CliError> {
        (300..400)
            .contains(&reply.status)
            .then(|| CliError::Redirected {
                origin: self.origin.clone(),
                status: reply.status,
                location: reply.location.clone(),
            })
    }

    fn send(&self, request: &Request, held: bool) -> Result<Reply, CliError> {
        let http = self.http.borrow();
        if request.credential && !http.has_credential() {
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
        Ok(http.call(
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
        )?)
    }

    /// Sends a request and answers its JSON on a `2xx`; anything else is the
    /// server's refusal, carried whole.
    pub fn json(&self, request: &Request) -> Result<Value, CliError> {
        let reply = self.call(request)?;
        if let Some(redirect) = self.redirected(&reply) {
            return Err(redirect);
        }
        read_json(reply, request)
    }

    /// The root, read whatever contract its answer names: saying which server
    /// this is, and that it speaks another contract, is what reading it is
    /// for.
    pub fn root(&self) -> Result<Value, CliError> {
        self.describe(&crate::commands::status::root_request())
    }

    /// The health door, read whatever contract its answer names, for the
    /// same reason as the root.
    pub fn health(&self) -> Result<Value, CliError> {
        self.describe(&crate::commands::status::health_request())
    }

    /// The one read that skips the contract check. Private, and reached only
    /// through `root` and `health`, so no other door can be read unchecked:
    /// a command handed this with its own request would print an answer on
    /// a contract it cannot read.
    fn describe(&self, request: &Request) -> Result<Value, CliError> {
        let reply = self.send(request, false)?;
        if let Some(redirect) = self.redirected(&reply) {
            return Err(redirect);
        }
        read_json(reply, request)
    }

    /// Sends a streamed request and hands back the body as a reader on a
    /// `2xx`. The transport reads a refusal whole even on a streamed call,
    /// so the envelope reaches the classification.
    pub fn stream(&self, request: &Request) -> Result<(String, Box<dyn Read + Send>), CliError> {
        let reply = self.call(request)?;
        if let Some(redirect) = self.redirected(&reply) {
            return Err(redirect);
        }
        match reply.body {
            ReplyBody::Stream(reader) => Ok((reply.content_type, reader)),
            ReplyBody::Text(text) => Err(refused(reply.status, &text, reply.retry_after_seconds)),
        }
    }
}

fn read_json(reply: Reply, request: &Request) -> Result<Value, CliError> {
    let text = match reply.body {
        ReplyBody::Text(text) => text,
        // The transport hands back a reader only for a streamed call,
        // which is `stream`'s to send.
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

/// A refusal as the server sent it: the code and message from the standard
/// envelope, from the OAuth shape, or the first of the body where there was
/// neither, which is what a page or a proxy in front of the server answers.
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
    use crate::door::{Answer, Door};

    fn remote_at(door: &Door, key: Option<&str>) -> Remote {
        Remote::with(Transport::new(&door.url, key).unwrap())
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

    /// The credential rides on a door that needs it and not on one that
    /// does not, and every call asks for JSON.
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

    /// A door that needs a credential is refused before the network when
    /// there is none: the door sees nothing.
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

    /// A `401` to a kept token is answered by one refresh and one retry:
    /// the door sees the refused call, the refresh with the spent token,
    /// and the call again under the new one. A later call refused again is
    /// refreshed again, once, and a token door that refuses that refresh is
    /// the answer.
    #[test]
    fn a_refused_kept_token_is_refreshed_once_and_the_call_sent_again() {
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            root(&marfa_client::CONTRACT_VERSION.to_string()),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Answer::json("200 OK", r#"{"data":[]}"#),
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"still"}}"#,
            ),
            root(&marfa_client::CONTRACT_VERSION.to_string()),
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
        // The refresh reads the keychain by the remote's origin, which is
        // the door's.
        let origin = Transport::new(&door.url, None).unwrap().origin();
        let _keychain = credentials::hold(&origin);
        match credentials::keep(&origin, &kept) {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                credentials::skipped(&reason);
                return;
            }
            Err(error) => panic!("{error}"),
        }
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
        // Each refresh reads the root first, since the answer it waits on is
        // the only copy of the rotated pair.
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

    /// The call sent again after a refresh is held to the contract as the
    /// first was.
    #[test]
    fn the_call_sent_again_after_a_refresh_is_held_to_the_contract() {
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            root(&marfa_client::CONTRACT_VERSION.to_string()),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Answer::json("200 OK", PAGE).on_contract(Some("2")),
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
        let origin = Transport::new(&door.url, None).unwrap().origin();
        let _keychain = credentials::hold(&origin);
        match credentials::keep(&origin, &kept) {
            Ok(()) => {}
            Err(CliError::NoKeychain(reason)) => {
                credentials::skipped(&reason);
                return;
            }
            Err(error) => panic!("{error}"),
        }
        let remote = Remote::holding(&door.url, kept).unwrap();
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::ContractMismatch { served, .. }) => {
                assert_eq!(served, "answers contract 2");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(door.received().len(), 4);
    }

    /// A refusal is the server's answer carried whole, and an empty
    /// success is `null` rather than a decoding failure.
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

    /// A streamed call hands the bytes back on a success and the envelope
    /// on a refusal, read whole.
    #[test]
    fn a_stream_is_a_reader_on_success_and_a_refusal_otherwise() {
        let door = Door::open(vec![
            Answer {
                status: "200 OK",
                content_type: "text/plain",
                body: "hello".into(),
                headers: Vec::new(),
            }
            .on_contract(Some(&marfa_client::CONTRACT_VERSION.to_string())),
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

    /// A file rides as its own bytes under the one type it was given.
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

    fn root(contract: &str) -> Answer {
        Answer::json(
            "200 OK",
            &format!(r#"{{"name":"marfa","version":"dev","contract":{contract},"features":[]}}"#),
        )
    }

    const PAGE: &str = r#"{"data":[],"next_cursor":null}"#;

    fn mismatch(result: Result<Value, CliError>) -> String {
        match result {
            Err(CliError::ContractMismatch {
                served, expected, ..
            }) => {
                assert_eq!(expected, marfa_client::CONTRACT_VERSION);
                served
            }
            other => panic!("{other:?}"),
        }
    }

    /// An answer that names another contract is refused rather than read,
    /// whatever its status, and without a round trip to the root first.
    #[test]
    fn an_answer_on_another_contract_is_refused() {
        let door = Door::open(vec![
            Answer::json("200 OK", PAGE).on_contract(Some("2")),
            Answer::json(
                "404 Not Found",
                r#"{"error":{"code":"item_not_found","message":"no"}}"#,
            )
            .on_contract(Some("2")),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        assert_eq!(
            mismatch(remote.json(&Request::get(&["items"]))),
            "answers contract 2"
        );
        assert_eq!(
            mismatch(remote.json(&Request::get(&["items", "i"]))),
            "answers contract 2"
        );
        let paths: Vec<String> = door
            .received()
            .iter()
            .map(|r| r.path().to_string())
            .collect();
        assert_eq!(paths, vec!["/items", "/items/i"]);
    }

    /// A success that names no contract is not one this binary can trust;
    /// a refusal that names none is handed on as it came, since a proxy in
    /// front of the server answers without one.
    #[test]
    fn a_success_naming_no_contract_is_refused_and_a_refusal_handed_on() {
        let door = Door::open(vec![
            Answer::json("200 OK", PAGE).on_contract(None),
            Answer::json(
                "502 Bad Gateway",
                r#"{"error":{"code":"bad_gateway","message":"upstream"}}"#,
            )
            .on_contract(None),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        assert_eq!(
            mismatch(remote.json(&Request::get(&["items"]))),
            "answered 200 naming no contract"
        );
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::Refused { status, .. }) => assert_eq!(status, 502),
            other => panic!("{other:?}"),
        }
        door.received();
    }

    /// The witness: answers on this binary's contract are read, with the
    /// bearer, and nothing reads the root.
    #[test]
    fn answers_on_this_contract_are_read_and_the_root_is_not() {
        let door = Door::open(vec![
            Answer::json("200 OK", PAGE),
            Answer::json("200 OK", PAGE),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        remote.json(&Request::get(&["items"])).unwrap();
        remote.json(&Request::get(&["edges"])).unwrap();
        let received = door.received();
        let paths: Vec<&str> = received.iter().map(|r| r.path()).collect();
        assert_eq!(paths, vec!["/items", "/edges"]);
        assert_eq!(
            received[0].header("authorization"),
            Some("Bearer marfa_k1_x")
        );
    }

    /// A stream is held to the contract on its headers, before a byte of it
    /// is handed back.
    #[test]
    fn a_stream_on_another_contract_is_refused() {
        let door = Door::open(vec![
            Answer {
                status: "200 OK",
                content_type: "text/event-stream",
                body: ": keepalive\n\n".into(),
                headers: Vec::new(),
            }
            .on_contract(Some("2")),
        ]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        match remote.stream(&Request::get(&["events"]).streamed()) {
            Err(CliError::ContractMismatch { served, .. }) => {
                assert_eq!(served, "answers contract 2");
            }
            other => panic!("{:?}", other.map(|_| ())),
        }
        door.received();
    }

    /// A root that refuses is that refusal, handed on: a real server reached
    /// under a mistyped prefix answers its own 404, and a proxy in front of
    /// one answers 401, and neither is a question of contract.
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
        let statuses: Vec<u16> = (0..2)
            .map(|_| match remote_at(&door, Some("marfa_k1_x")).root() {
                Err(CliError::Refused { status, .. }) => status,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(statuses, vec![404, 401]);
        door.received();
    }

    /// A read refused on another contract says nothing about a write, and
    /// carries the status the server answered.
    #[test]
    fn a_read_refused_on_another_contract_says_no_write_was_sent() {
        let door = Door::open(vec![Answer::json("200 OK", PAGE).on_contract(Some("2"))]);
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

    /// A write answered on another contract is refused all the same, and the
    /// refusal says the write was sent: the answer that names the contract
    /// comes after the server acted.
    #[test]
    fn a_write_answered_on_another_contract_says_it_was_sent() {
        let door = Door::open(vec![
            Answer::json("201 Created", r#"{"item":{"id":"i"}}"#).on_contract(Some("2")),
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

    /// An answer on another contract comes back with its status and headers
    /// only: its body is not read. `describe` reads it, since saying what
    /// the server is is what it is for.
    #[test]
    fn the_body_of_an_answer_on_another_contract_is_not_read() {
        let door = Door::open(vec![
            Answer::json("200 OK", PAGE).on_contract(Some("2")),
            Answer::json("200 OK", PAGE).on_contract(Some("2")),
        ]);
        let transport = Transport::new(&door.url, Some("marfa_k1_x")).unwrap();
        let call = || Call {
            method: request::Method::Get,
            segments: &["items"],
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        };
        let text = |reply: Reply| match reply.body {
            ReplyBody::Text(text) => text,
            ReplyBody::Stream(_) => panic!("a stream"),
        };
        assert_eq!(text(transport.call(call(), true).unwrap()), "");
        // The witness: the same answer, not held, is read.
        assert_eq!(text(transport.call(call(), false).unwrap()), PAGE);
        door.received();
    }

    /// The witness: a root on another contract is read and handed back, since
    /// saying which contract a server speaks is what reading it is for.
    #[test]
    fn a_root_on_another_contract_is_described() {
        let door = Door::open(vec![root("2").on_contract(Some("2"))]);
        let instance = remote_at(&door, Some("marfa_k1_x")).root().unwrap();
        assert_eq!(instance["contract"], 2);
        let received = door.received();
        assert_eq!(received[0].header("authorization"), None);
    }

    /// A redirect is the refusal it is, not a hop the credential follows:
    /// the door sees one request and the caller hears the status.
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

    /// `Retry-After` reaches the refusal off the wire, as seconds and as an
    /// HTTP-date read against the response's own `Date`.
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

    /// A header a command names, such as the stream's `Last-Event-ID`,
    /// arrives as it was given.
    #[test]
    fn a_named_header_reaches_the_wire() {
        let door = Door::open(vec![Answer::json("200 OK", r#"{"data":[]}"#)]);
        let remote = remote_at(&door, Some("marfa_k1_x"));
        remote
            .json(&Request::get(&["items"]).header("Last-Event-ID", "42"))
            .unwrap();
        assert_eq!(door.received()[0].header("last-event-id"), Some("42"));
    }

    /// A root that refuses for a reason that is not the contract, a 503
    /// while a server starts, is that refusal, retryable, not a mismatch.
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

    /// A root that redirects is refused as a redirect, rather than read as a
    /// server with no contract.
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

    /// A server that sends an answer a byte at a time, each well inside the
    /// read budget, over a longer time than the whole-answer budget.
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
                    marfa_client::CONTRACT_VERSION,
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
        Remote::with(
            Transport::budgeted(
                url,
                Some("marfa_k1_x"),
                std::time::Duration::from_millis(read_ms),
                std::time::Duration::from_millis(whole_ms),
            )
            .unwrap(),
        )
    }

    /// A JSON answer is bounded as a whole: one that keeps arriving, each
    /// byte inside the read budget, is given up on at the whole budget.
    #[test]
    fn a_json_answer_is_bounded_as_a_whole() {
        match budgeted(&trickling(false), 2_000, 600).json(&Request::get(&["items"])) {
            Err(CliError::Core(marfa_core::CoreError::Network(_))) => {}
            other => panic!("{other:?}"),
        }
    }

    /// A streamed answer has no whole budget: the same trickle is read to
    /// its end, which the JSON call above was not.
    #[test]
    fn a_stream_outlasts_the_whole_answer_budget() {
        let (_, mut reader) = budgeted(&trickling(true), 2_000, 600)
            .stream(&Request::get(&["export"]).streamed())
            .unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "0123456789");
    }

    /// A server that accepts the connection and never answers is given up
    /// on at the read budget, a stream included, rather than waited on
    /// forever.
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

    /// A file's upload has no time budget, since reqwest's bound on a call
    /// covers sending its body too: the same slow server that runs a JSON
    /// call out of both budgets answers the upload.
    #[test]
    fn an_upload_outlasts_the_budgets() {
        let slow = || {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    // Read the whole request, a chunked body included, so the
                    // answer is not cut off by unread bytes when it closes.
                    let mut seen = Vec::new();
                    let mut chunk = [0u8; 4096];
                    while !seen.ends_with(b"0\r\n\r\n") && !seen.ends_with(b"{}") {
                        match std::io::Read::read(&mut stream, &mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => seen.extend_from_slice(&chunk[..n]),
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let body = r#"{"hash":"sha256:h"}"#;
                    let _ = std::io::Write::write_all(
                        &mut stream,
                        format!(
                            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            marfa_core::http::CONTRACT_HEADER,
                            marfa_client::CONTRACT_VERSION,
                            body.len()
                        )
                        .as_bytes(),
                    );
                }
            });
            let budget = std::time::Duration::from_millis(500);
            Remote::with(Transport::budgeted(&url, Some("marfa_k1_x"), budget, budget).unwrap())
        };
        let dir = std::env::temp_dir().join(format!("marfa-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bytes.bin");
        std::fs::write(&path, b"bytes").unwrap();
        slow()
            .json(&Request::post(&["blobs"]).file(path, "application/octet-stream"))
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        // The witness: a JSON call to the same server runs out of its budget.
        match slow().json(&Request::post(&["items"]).json(serde_json::json!({}))) {
            Err(CliError::Core(marfa_core::CoreError::Network(_))) => {}
            other => panic!("{other:?}"),
        }
    }

    /// A transport failure says why, not only that the request failed.
    #[test]
    fn a_transport_failure_carries_its_cause() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let remote = Remote::with(
            Transport::new(&format!("http://127.0.0.1:{port}"), Some("marfa_k1_x")).unwrap(),
        );
        match remote.json(&Request::get(&["items"])) {
            Err(CliError::Core(marfa_core::CoreError::Network(text))) => {
                assert!(text.to_lowercase().contains("refused"), "{text}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// `whoami` against a server on another contract reports the contract
    /// and no person, and sends the token nowhere past the description. The
    /// witness is `cli/login.test.ts`: on the server's own contract the same
    /// command goes on to the identity door and names the person.
    #[test]
    fn whoami_on_another_contract_names_no_person() {
        let door = Door::open(vec![root("2").on_contract(Some("2"))]);
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
