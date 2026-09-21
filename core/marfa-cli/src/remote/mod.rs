//! The server a direct command talks to, and how it talks to it.

pub mod request;

use std::cell::RefCell;
use std::fs::File;
use std::io::Read;

use marfa_core::Server;
use marfa_core::http::{Call, CallBody, Http, Reply, ReplyBody};
use serde_json::Value;

use crate::auth;
use crate::credentials::{self, Kept};
use crate::error::CliError;
use request::{Body, Request};

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
    http: RefCell<Http>,
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
        let origin = Http::new(&url, None)?.origin();
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
        let http = Http::new(&url, key.as_deref())?;
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
        *self.http.borrow_mut() = Http::new(&self.url, Some(&bearer))?;
        *self.bearer.borrow_mut() = Some(bearer);
        *self.kept.borrow_mut() = Some(next);
        Ok(())
    }

    /// A remote holding a keychain entry, for the tests of the refresh
    /// path, which `resolve` reaches only through the real keychain.
    #[cfg(test)]
    pub(crate) fn holding(url: &str, kept: Kept) -> Result<Remote, CliError> {
        let http = Http::new(url, Some(kept.bearer()))?;
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
        let http = Http::new(url, None)?;
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
    pub fn with(http: Http) -> Remote {
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
    /// A `401` to a kept token is answered by one refresh and one retry,
    /// because the token may have been rotated by another process since
    /// this one read the keychain, or have run out between the read and
    /// the call.
    pub fn call(&self, request: &Request) -> Result<Reply, CliError> {
        let reply = self.send(request)?;
        if reply.status == 401 && request.credential && self.can_refresh() {
            self.refreshed()?;
            return self.send(request);
        }
        Ok(reply)
    }

    fn send(&self, request: &Request) -> Result<Reply, CliError> {
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
        Ok(http.call(Call {
            method: request.method,
            segments: &segments,
            params: &params,
            headers: &headers,
            body,
            credential: request.credential,
            stream: request.stream,
        })?)
    }

    /// Sends a request and answers its JSON on a `2xx`; anything else is the
    /// server's refusal, carried whole.
    pub fn json(&self, request: &Request) -> Result<Value, CliError> {
        let reply = self.call(request)?;
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

    /// Sends a streamed request and hands back the body as a reader on a
    /// `2xx`. The transport reads a refusal whole even on a streamed call,
    /// so the envelope reaches the classification.
    pub fn stream(&self, request: &Request) -> Result<(String, Box<dyn Read + Send>), CliError> {
        let reply = self.call(request)?;
        match reply.body {
            ReplyBody::Stream(reader) => Ok((reply.content_type, reader)),
            ReplyBody::Text(text) => Err(refused(reply.status, &text, reply.retry_after_seconds)),
        }
    }
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
        Remote::with(Http::new(&door.url, key).unwrap())
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
        let _keychain = credentials::hold();
        let door = Door::open(vec![
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
            ),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_new","refresh_token":"marfa_rt_new","expires_in":3600,"token_type":"Bearer"}"#,
            ),
            Answer::json("200 OK", r#"{"data":[]}"#),
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"still"}}"#,
            ),
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
        let origin = Http::new(&door.url, None).unwrap().origin();
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
        let _ = credentials::forget(&origin);
        let received = door.received();
        assert_eq!(received.len(), 5);
        assert_eq!(received[0].path(), "/items");
        assert_eq!(
            received[0].header("authorization"),
            Some("Bearer marfa_at_old")
        );
        assert_eq!(received[1].path(), "/auth/oauth2/token");
        assert!(
            received[1].body.contains("refresh_token=marfa_rt_old"),
            "{}",
            received[1].body
        );
        assert_eq!(received[2].path(), "/items");
        assert_eq!(
            received[2].header("authorization"),
            Some("Bearer marfa_at_new")
        );
        assert_eq!(received[3].path(), "/items");
        assert_eq!(received[4].path(), "/auth/oauth2/token");
        assert!(
            received[4].body.contains("refresh_token=marfa_rt_new"),
            "{}",
            received[4].body
        );
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
            },
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
}
