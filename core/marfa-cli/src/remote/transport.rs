//! The binary's way to the server: the client generated from the document
//! carries every call, and the contract it was generated for is what the
//! root is held to before anything that carries a credential is sent.
//!
//! The binary's commands build their requests from their arguments and read
//! the answers as they came, so what it takes from the generated crate is
//! the configuration a call rides on, the one generated operation it calls
//! typed (the root), and the contract version.

use std::time::Duration;

use marfa_client::apis::configuration::Configuration;
use marfa_client::apis::instance_api;
use marfa_core::CoreError;
use marfa_core::http::{Call, CallBody, Reply, ReplyBody, retry_after_seconds};
use reqwest::blocking::{Body, Client};
use url::Url;

/// How long a call that is read whole may take, from the request to the last
/// byte of the answer. A streamed call has no such budget: the event stream,
/// an export and a blob's bytes have no length one could be sized for, and
/// `events --for` bounds its own reading.
const WHOLE_ANSWER_BUDGET: Duration = Duration::from_secs(90);

/// How long any read may wait for the next bytes, headers included, so a
/// server that accepts a connection and never answers is given up on. Above
/// the event stream's 30-second keepalive, so an idle stream is not.
const READ_BUDGET: Duration = Duration::from_secs(45);

pub struct Transport {
    config: Configuration,
    base: Url,
}

/// What the root said about the contract it serves.
#[derive(Debug, Clone)]
pub enum Served {
    /// The contract this binary was generated for.
    Expected,
    /// Another one, or no reading of one, as a person should hear it.
    Other(String),
    /// The root refused for a reason that is not about the contract: a
    /// proxy's 502, a 429, a 503 while the server starts.
    Refused {
        status: u16,
        text: String,
        retry_after_seconds: Option<u64>,
    },
}

impl Served {
    /// Reads a root's answer: its `contract` against the one this binary was
    /// generated for.
    pub fn of(text: &str) -> Served {
        let contract = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|root| root.get("contract").cloned());
        match contract.as_ref().and_then(serde_json::Value::as_u64) {
            Some(served) if served == marfa_client::CONTRACT_VERSION => Served::Expected,
            Some(served) => Served::Other(served.to_string()),
            None => Served::Other(match contract {
                Some(other) => format!("an unreadable contract ({other})"),
                None => "no contract".to_string(),
            }),
        }
    }
}

/// Scheme, host, port and path prefix: what identifies a server without
/// identifying a key.
pub fn origin_of(url: &str) -> Result<String, CoreError> {
    Ok(origin(&base_of(url)?))
}

fn origin(base: &Url) -> String {
    format!(
        "{}{}",
        base.origin().ascii_serialization(),
        base.path().trim_end_matches('/')
    )
}

fn base_of(url: &str) -> Result<Url, CoreError> {
    let mut base = Url::parse(url)?;
    if base.cannot_be_a_base() {
        return Err(CoreError::Invalid(format!("not a server url: {url}")));
    }
    let path = base.path().trim_end_matches('/').to_string();
    base.set_path(&path);
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

/// A transport failure with every cause it carries: reqwest's own message
/// leaves out the one that says why.
fn network(error: &dyn std::error::Error) -> CoreError {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    CoreError::Network(text)
}

impl Transport {
    pub fn new(url: &str, key: Option<&str>) -> Result<Transport, CoreError> {
        let base = base_of(url)?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // The blocking client applies this to each read and write, which
            // is the per-read bound `READ_BUDGET` names.
            .timeout(READ_BUDGET)
            // A redirect is answered as the refusal it is rather than
            // followed: reqwest keeps the bearer on a same-origin hop, and
            // nothing the binary calls redirects.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| network(&error))?;
        let config = Configuration {
            base_path: base.as_str().trim_end_matches('/').to_string(),
            user_agent: Some("marfa".to_string()),
            client,
            basic_auth: None,
            oauth_access_token: None,
            bearer_access_token: key.map(str::to_string),
            api_key: None,
        };
        Ok(Transport { config, base })
    }

    pub fn origin(&self) -> String {
        origin(&self.base)
    }

    pub fn has_credential(&self) -> bool {
        self.config.bearer_access_token.is_some()
    }

    /// Reads the root through the generated operation and compares the
    /// contract it answers with the one the crate was generated for. Only a
    /// transport failure is an `Err`.
    pub fn served(&self) -> Result<Served, CoreError> {
        match instance_api::get_instance(&self.config) {
            Ok(answer) => Ok(Served::of(&answer.content)),
            // A server with no root is not one speaking any contract.
            Err(marfa_client::apis::Error::ResponseError(refused))
                if refused.status.as_u16() == 404 =>
            {
                Ok(Served::Other("no contract (its root answered 404)".into()))
            }
            Err(marfa_client::apis::Error::ResponseError(refused)) => {
                let header = |name: &str| {
                    refused
                        .headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                };
                Ok(Served::Refused {
                    status: refused.status.as_u16(),
                    retry_after_seconds: retry_after_seconds(header("Retry-After"), header("Date")),
                    text: refused.content,
                })
            }
            Err(error) => Err(network(&error)),
        }
    }

    /// Sends one call from the direct surface and reads whatever came back.
    /// **The only `Err` is a transport failure**: every status the server
    /// answers is a `Reply`, classified by the caller on the status and the
    /// envelope together.
    pub fn call(&self, call: Call<'_>) -> Result<Reply, CoreError> {
        let url = self.url(call.segments, call.params);
        let method = reqwest::Method::from_bytes(call.method.as_str().as_bytes())
            .map_err(|error| CoreError::Invalid(format!("this call cannot be sent: {error}")))?;
        let mut request = self.config.client.request(method, url).header(
            "Accept",
            if call.stream {
                "*/*"
            } else {
                "application/json"
            },
        );
        if let Some(agent) = &self.config.user_agent {
            request = request.header("User-Agent", agent);
        }
        if !call.stream {
            request = request.timeout(WHOLE_ANSWER_BUDGET);
        }
        if call.credential
            && let Some(key) = &self.config.bearer_access_token
        {
            request = request.bearer_auth(key);
        }
        if matches!(call.body, CallBody::Json(_)) {
            request = request.header("Content-Type", "application/json");
        }
        for (name, value) in call.headers {
            request = request.header(*name, *value);
        }
        request = match call.body {
            CallBody::None => request,
            CallBody::Json(text) | CallBody::Text(text) => request.body(text.to_string()),
            // Streamed as it is read, never buffered: the cap on a body is
            // the server's to set.
            CallBody::Reader(reader) => request.body(Body::new(reader)),
        };
        let response = request.send().map_err(|error| network(&error))?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let retry_after_seconds = retry_after_seconds(header("Retry-After"), header("Date"));
        let content_type = header("Content-Type").unwrap_or("").to_string();
        // A refusal is read whole even on a streamed call, so the envelope
        // reaches the classification; only a success is handed back as a
        // reader.
        let body = if call.stream && (200..300).contains(&status) {
            ReplyBody::Stream(Box::new(response))
        } else {
            ReplyBody::Text(response.text().map_err(|error| network(&error))?)
        };
        Ok(Reply {
            status,
            content_type,
            retry_after_seconds,
            body,
        })
    }

    fn url(&self, segments: &[&str], params: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().expect("a server url has a path");
            path.pop_if_empty();
            path.extend(segments);
        }
        if !params.is_empty() {
            let mut query = url.query_pairs_mut();
            for (key, value) in params {
                query.append_pair(key, value);
            }
        }
        url
    }
}
