//! The binary's way to the server: the client generated from the document
//! carries every call, and the contract it was generated for is what the
//! root is held to before anything else is sent.
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

pub struct Transport {
    config: Configuration,
    base: Url,
}

/// What the root said about the contract it serves.
pub enum Served {
    /// The contract this binary was generated for.
    Expected,
    /// Another one, or no reading of one, as a person should hear it.
    Other(String),
}

impl Transport {
    pub fn new(url: &str, key: Option<&str>) -> Result<Transport, CoreError> {
        let mut base = Url::parse(url)?;
        if base.cannot_be_a_base() {
            return Err(CoreError::Invalid(format!("not a server url: {url}")));
        }
        let path = base.path().trim_end_matches('/').to_string();
        base.set_path(&path);
        base.set_query(None);
        base.set_fragment(None);
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(None)
            .build()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        let config = Configuration {
            base_path: base.as_str().trim_end_matches('/').to_string(),
            user_agent: Some("marfa".to_string()),
            client,
            bearer_access_token: key.map(str::to_string),
            ..Configuration::default()
        };
        Ok(Transport { config, base })
    }

    /// Scheme, host, port and path prefix: what identifies a server without
    /// identifying a key.
    pub fn origin(&self) -> String {
        format!(
            "{}{}",
            self.base.origin().ascii_serialization(),
            self.base.path().trim_end_matches('/')
        )
    }

    pub fn has_credential(&self) -> bool {
        self.config.bearer_access_token.is_some()
    }

    /// Reads the root through the generated operation and compares the
    /// contract it answers with the one the crate was generated for. Only
    /// a transport failure is an `Err`: a root that answers something else,
    /// or nothing readable, is a contract this binary cannot trust.
    pub fn served(&self) -> Result<Served, CoreError> {
        let content = match instance_api::get_instance(&self.config) {
            Ok(content) => content.content,
            Err(marfa_client::apis::Error::ResponseError(refused)) => {
                return Ok(Served::Other(format!(
                    "no contract (its root answered {})",
                    refused.status.as_u16()
                )));
            }
            Err(marfa_client::apis::Error::Reqwest(error)) => {
                return Err(CoreError::Network(error.to_string()));
            }
            Err(error) => return Err(CoreError::Network(error.to_string())),
        };
        let contract = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|root| root.get("contract").cloned());
        Ok(
            match contract.as_ref().and_then(serde_json::Value::as_u64) {
                Some(served) if served == marfa_client::CONTRACT_VERSION => Served::Expected,
                Some(served) => Served::Other(served.to_string()),
                None => Served::Other(match contract {
                    Some(other) => format!("an unreadable contract ({other})"),
                    None => "no contract".to_string(),
                }),
            },
        )
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
        let response = request
            .send()
            .map_err(|error| CoreError::Network(error.to_string()))?;
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
            ReplyBody::Text(
                response
                    .text()
                    .map_err(|error| CoreError::Network(error.to_string()))?,
            )
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
