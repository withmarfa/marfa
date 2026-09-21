//! The server a command talks to, and how it talks to it.

pub mod request;

use std::fs::File;
use std::io::Read;

use marfa_core::Server;
use marfa_core::http::{Call, CallBody, Http, Reply, ReplyBody};
use serde_json::Value;

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
    http: Http,
    url: String,
    origin: String,
    credential: Option<CredentialSource>,
    bearer: Option<String>,
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
    /// so a key kept in the keychain reaches `device` and `folders` too.
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
            // The origin a kept key made current. A keychain that cannot be
            // asked is not an error here: the flag and the environment were
            // empty, so the answer is that no server was named, and the
            // message says how to name one.
            None => match credentials::current() {
                Ok(Some(origin)) => origin,
                Ok(None) | Err(CliError::NoKeychain(_)) => return Err(CliError::NoServerNamed),
                Err(error) => return Err(error),
            },
        };
        let origin = Http::new(&url, None)?.origin();
        let (key, credential) = match named.key.clone() {
            Some(key) => (Some(key), Some(CredentialSource::Flag)),
            None => match non_empty(std::env::var("MARFA_API_KEY").ok()) {
                Some(key) => (Some(key), Some(CredentialSource::Environment)),
                None => match credentials::read(&origin) {
                    Ok(Some(Kept::Key { key })) => (Some(key), Some(CredentialSource::Keychain)),
                    Ok(None) | Err(CliError::NoKeychain(_)) => (None, None),
                    Err(error) => return Err(error),
                },
            },
        };
        let http = Http::new(&url, key.as_deref())?;
        Ok(Remote {
            http,
            url,
            origin,
            credential,
            bearer: key,
        })
    }

    /// The credential's bearer value, for keeping it.
    pub fn bearer(&self) -> Option<String> {
        self.bearer.clone()
    }

    /// A remote over a transport built for one call, such as the bootstrap
    /// mint, which carries the printed secret rather than a key.
    pub fn with(http: Http) -> Remote {
        let origin = http.origin();
        Remote {
            url: origin.clone(),
            http,
            origin,
            credential: Some(CredentialSource::Flag),
            bearer: None,
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

    /// Sends a request. The only `Err` is a transport failure or a missing
    /// credential; every status the server answers is a `Reply`.
    pub fn call(&self, request: &Request) -> Result<Reply, CliError> {
        if request.credential && !self.http.has_credential() {
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
        };
        Ok(self.http.call(Call {
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
            ReplyBody::Stream(mut reader) => {
                let mut text = String::new();
                reader.read_to_string(&mut text)?;
                text
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

    /// Sends a request and hands back the body as a reader on a `2xx`.
    pub fn stream(&self, request: &Request) -> Result<(String, Box<dyn Read + Send>), CliError> {
        let reply = self.call(request)?;
        match reply.body {
            ReplyBody::Stream(reader) if (200..300).contains(&reply.status) => {
                Ok((reply.content_type, reader))
            }
            ReplyBody::Stream(mut reader) => {
                let mut text = String::new();
                reader.read_to_string(&mut text)?;
                Err(refused(reply.status, &text, reply.retry_after_seconds))
            }
            ReplyBody::Text(text) => {
                if (200..300).contains(&reply.status) {
                    Ok((
                        reply.content_type,
                        Box::new(std::io::Cursor::new(text.into_bytes())),
                    ))
                } else {
                    Err(refused(reply.status, &text, reply.retry_after_seconds))
                }
            }
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
/// envelope, or the first of the body where there was none, which is what a
/// page or a proxy in front of the server answers.
pub fn refused(status: u16, text: &str, retry_after_seconds: Option<u64>) -> CliError {
    let (code, message, details) = match serde_json::from_str::<Envelope>(text) {
        Ok(envelope) => (
            envelope.error.code,
            envelope.error.message.unwrap_or_default(),
            envelope.error.details.map(Box::new),
        ),
        Err(_) => (
            "unknown".to_string(),
            text.chars().take(200).collect(),
            None,
        ),
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

    #[test]
    fn a_refusal_keeps_the_envelope_and_the_first_of_a_body_that_is_not_one() {
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
}
