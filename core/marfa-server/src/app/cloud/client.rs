//! Requests to Marfa Cloud's link API, at the origin `MARFA_CLOUD_URL` names.

use std::io::Read;
use std::net::SocketAddr;
use std::time::Duration;

use serde_json::Value;
use ureq::Agent;
use ureq::http::header;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;
use url::Url;

use crate::app::App;
use crate::app::outbound::{self, Asker, Pinned, Reach};
use crate::settings::sealed::Secret;

const TIME: Duration = Duration::from_secs(10);
const MOST_ADDRESSES: usize = 16;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failed {
    Unreachable,
    TimedOut,
}

impl Failed {
    pub fn word(self) -> &'static str {
        match self {
            Failed::Unreachable => "unreachable",
            Failed::TimedOut => "timed_out",
        }
    }
}

/// What Marfa Cloud answered: its status, the body where it read as JSON, and `Retry-After`.
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
    pub retry_after: Option<Duration>,
}

pub enum Method {
    Get,
    Post(Value),
}

pub async fn send(
    app: &App,
    method: Method,
    path: &str,
    credential: Option<&Secret>,
) -> Result<Answer, Failed> {
    let url = Url::parse(app.settings.start.cloud_url.origin())
        .and_then(|origin| origin.join(path))
        .map_err(|_| Failed::Unreachable)?;
    let port = url.port_or_known_default().ok_or(Failed::Unreachable)?;
    let pinned: Vec<SocketAddr> = match outbound::reach(&app.faults, &url, true, Asker::Cloud).await
    {
        Reach::Targets(targets) => targets
            .into_iter()
            .take(MOST_ADDRESSES)
            .map(|target| SocketAddr::new(target.connected, port))
            .collect(),
        Reach::Unresolved | Reach::NoSlot | Reach::NotPublic => return Err(Failed::Unreachable),
    };
    let bearer = credential.map(|secret| format!("Bearer {}", secret.expose()));
    let asked = tokio::task::spawn_blocking(move || ask(&url, pinned, &method, bearer.as_deref()));
    match tokio::time::timeout(TIME + Duration::from_secs(1), asked).await {
        Ok(Ok(answered)) => answered,
        Ok(Err(_)) => Err(Failed::Unreachable),
        Err(_) => Err(Failed::TimedOut),
    }
}

fn ask(
    url: &Url,
    pinned: Vec<SocketAddr>,
    method: &Method,
    bearer: Option<&str>,
) -> Result<Answer, Failed> {
    let tls = TlsConfig::builder()
        .root_certs(RootCerts::PlatformVerifier)
        .build();
    let config = Agent::config_builder()
        .https_only(url.scheme() == "https")
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(TIME))
        .max_response_header_size(MAX_HEADER_BYTES)
        .tls_config(tls)
        .user_agent("marfa-server")
        .build();
    let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(pinned));
    let failed = |error: ureq::Error| match error {
        ureq::Error::Timeout(_) => Failed::TimedOut,
        _ => Failed::Unreachable,
    };
    let mut response = match method {
        Method::Get => {
            let mut request = agent
                .get(url.as_str())
                .header(header::ACCEPT, "application/json");
            if let Some(bearer) = bearer {
                request = request.header(header::AUTHORIZATION, bearer);
            }
            request.call().map_err(failed)?
        }
        Method::Post(body) => {
            let mut request = agent
                .post(url.as_str())
                .header(header::ACCEPT, "application/json")
                .header(header::CONTENT_TYPE, "application/json");
            if let Some(bearer) = bearer {
                request = request.header(header::AUTHORIZATION, bearer);
            }
            request.send(body.to_string().as_bytes()).map_err(failed)?
        }
    };
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_BODY_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| Failed::Unreachable)?;
    Ok(Answer {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        retry_after,
    })
}
