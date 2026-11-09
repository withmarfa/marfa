//! Fetches untrusted URLs through public, pinned addresses without redirects.

use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use ureq::Agent;
use ureq::unversioned::transport::DefaultConnector;
use url::Url;

use crate::app::App;
use crate::app::access::Caller;
use crate::app::blobs::{Blob, DEFAULT_TYPE};
use crate::app::limiter::{FILE_FETCHES, Lane, retry_seconds};
use crate::app::outbound::{self, Pinned, Reach};
use crate::app::provenance;
use crate::app::refusal::Refusal;
use crate::settings::registry::{
    MCP_FETCH_ENABLED, MCP_FETCH_MAX_BYTES, MCP_FETCH_TIMEOUT_MS, RATE_LIMIT_ENABLED,
    RATE_LIMIT_WINDOW_MS,
};

/// How many files the instance fetches for tools at once.
pub const AT_ONCE: usize = 4;
/// How many fetches one credential's tool calls make in a rate-limit window.
pub const PER_WINDOW: u64 = 30;

const CHUNK: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MOST_ADDRESSES: usize = 16;
const MAX_FILE_NAME: usize = 200;

/// Why a file was not fetched, as an agent is told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reason {
    BadUrl,
    NotPublic,
    Redirect,
    Timeout,
    Unreachable,
    TooLarge,
    Status(u16),
    Busy,
    Disabled,
    RateLimited(i64),
}

impl Reason {
    pub fn word(&self) -> &'static str {
        match self {
            Reason::BadUrl => "bad_url",
            Reason::NotPublic => "not_public",
            Reason::Redirect => "redirect",
            Reason::Timeout => "timeout",
            Reason::Unreachable => "unreachable",
            Reason::TooLarge => "too_large",
            Reason::Status(_) => "status",
            Reason::Busy => "busy",
            Reason::Disabled => "disabled",
            Reason::RateLimited(_) => "rate_limited",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Reason::BadUrl => "The address is not a public http or https address.".to_string(),
            Reason::NotPublic => {
                "The address names a host that is not on the public internet, so it was not fetched."
                    .to_string()
            }
            Reason::Redirect => {
                "The address redirects elsewhere. Redirects are not followed; send the address the file is at."
                    .to_string()
            }
            Reason::Timeout => "The host took too long to send the file.".to_string(),
            Reason::Unreachable => "The host could not be reached.".to_string(),
            Reason::TooLarge => "The file is larger than this instance fetches.".to_string(),
            Reason::Status(status) => format!("The host answered {status} instead of the file."),
            Reason::Busy => {
                "The instance is already fetching as many files as it may at once. Try again shortly."
                    .to_string()
            }
            Reason::Disabled => "This instance does not fetch files for tools. Save the item without the file, or ask the owner to turn fetching on."
                .to_string(),
            Reason::RateLimited(_) => {
                "This credential has fetched as many files as it may for now.".to_string()
            }
        }
    }
}

/// A fetch that ended without a file: the host or the limits said no, or the store refused it.
pub enum Failed {
    Not(Reason),
    Refused(Refusal),
}

impl From<Refusal> for Failed {
    fn from(refusal: Refusal) -> Failed {
        Failed::Refused(refusal)
    }
}

pub struct Fetched {
    pub blob: Blob,
    pub file_name: Option<String>,
}

/// Paths and queries can contain secrets; log only lengths and a path hash.
fn audited(raw: &str, parsed: Option<&Url>) -> serde_json::Value {
    let Some(url) = parsed else {
        return serde_json::json!({ "address_length": raw.chars().count() });
    };
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => String::new(),
    };
    serde_json::json!({
        "scheme": url.scheme(),
        "host": host,
        "path_length": url.path().len(),
        "path_sha256": hex::encode(Sha256::digest(url.path().as_bytes())),
        "query_length": url.query().map_or(0, str::len),
    })
}

fn checked(raw: &str) -> Result<Url, Reason> {
    let url = Url::parse(raw).map_err(|_| Reason::BadUrl)?;
    let plain = matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none();
    if plain { Ok(url) } else { Err(Reason::BadUrl) }
}

/// Every DNS answer must be public; only checked addresses may be reached.
fn resolved(app: &App, handle: &Handle, url: &Url) -> Result<Vec<SocketAddr>, Reason> {
    let port = url.port_or_known_default().ok_or(Reason::BadUrl)?;
    match handle.block_on(outbound::reach(&app.faults, url, false)) {
        Reach::Targets(targets) => Ok(targets
            .into_iter()
            .take(MOST_ADDRESSES)
            .map(|target| SocketAddr::new(target.connected, port))
            .collect()),
        Reach::Unresolved => Err(Reason::Unreachable),
        Reach::NotPublic => Err(Reason::NotPublic),
    }
}

/// The name the host gives the file, with no directory in it.
fn file_name_in(disposition: &str) -> Option<String> {
    let at = disposition.to_ascii_lowercase().find("filename=")?;
    let rest = disposition.get(at + "filename=".len()..)?.trim_start();
    let name = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().unwrap_or_default(),
        None => rest.split(';').next().unwrap_or_default(),
    };
    let name: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|at| !at.is_control())
        .take(MAX_FILE_NAME)
        .collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn media_type_of(headers: &ureq::http::HeaderMap) -> Option<String> {
    headers
        .get(ureq::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|essence| essence.trim().to_ascii_lowercase())
        .filter(|essence| !essence.is_empty())
}

struct Limits {
    max_bytes: u64,
    time: Duration,
}

/// Runs on a blocking thread: the body is read there, and handed to the store a chunk at a time.
fn stream(
    app: &Arc<App>,
    handle: &Handle,
    caller: &Caller,
    url: &Url,
    mime_hint: Option<String>,
    limits: &Limits,
) -> Result<Fetched, Failed> {
    let addresses = resolved(app, handle, url).map_err(Failed::Not)?;
    let started = Instant::now();
    let config = Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(limits.time))
        .max_response_header_size(MAX_HEADER_BYTES)
        .user_agent("marfa-server")
        .build();
    let agent = Agent::with_parts(config, DefaultConnector::default(), Pinned(addresses));
    let mut response = agent
        .get(url.as_str())
        .header(ureq::http::header::ACCEPT_ENCODING, "identity")
        .call()
        .map_err(|error| {
            Failed::Not(match error {
                ureq::Error::Timeout(_) => Reason::Timeout,
                ureq::Error::BadUri(_) | ureq::Error::Http(_) => Reason::BadUrl,
                _ => Reason::Unreachable,
            })
        })?;
    let status = response.status().as_u16();
    match status {
        200..=299 => {}
        300..=399 => return Err(Failed::Not(Reason::Redirect)),
        _ => return Err(Failed::Not(Reason::Status(status))),
    }
    let declared = response
        .headers()
        .get(ureq::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > limits.max_bytes) {
        return Err(Failed::Not(Reason::TooLarge));
    }
    let media_type = media_type_of(response.headers())
        .or(mime_hint)
        .unwrap_or_else(|| DEFAULT_TYPE.to_string());
    let file_name = response
        .headers()
        .get(ureq::http::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(file_name_in);
    let mut intake = handle.block_on(app.begin_upload(declared, media_type))?;
    let mut reader = response.body_mut().as_reader();
    let mut buffer = vec![0u8; CHUNK];
    let mut total: u64 = 0;
    let ended = loop {
        match reader.read(&mut buffer) {
            Ok(0) => break None,
            Ok(count) => {
                total += count as u64;
                if total > limits.max_bytes {
                    break Some(Failed::Not(Reason::TooLarge));
                }
                if let Err(refusal) = handle.block_on(intake.push(buffer[..count].to_vec())) {
                    break Some(Failed::Refused(refusal));
                }
            }
            Err(_) => {
                break Some(Failed::Not(if started.elapsed() >= limits.time {
                    Reason::Timeout
                } else {
                    Reason::Unreachable
                }));
            }
        }
    };
    if let Some(failed) = ended {
        handle.block_on(intake.discard());
        return Err(failed);
    }
    let blob = handle.block_on(app.finish_upload(caller, intake))?;
    Ok(Fetched { blob, file_name })
}

/// Records every fetch attempt, including refusals. The attempt and its record run as
/// their own task, so a caller that goes away mid-fetch still leaves the record.
pub async fn file(
    app: &Arc<App>,
    caller: &Caller,
    raw: &str,
    mime_hint: Option<String>,
) -> Result<Fetched, Failed> {
    let (app, caller, raw) = (app.clone(), caller.clone(), raw.to_string());
    let origin = provenance::current();
    tokio::spawn(provenance::within(origin, async move {
        let parsed = checked(&raw);
        let outcome = match &parsed {
            Ok(url) => attempt(&app, &caller, url, mime_hint).await,
            Err(reason) => Err(Failed::Not(reason.clone())),
        };
        record(&app, &caller, &raw, parsed.ok().as_ref(), &outcome).await;
        outcome
    }))
    .await
    .unwrap_or_else(|_| Err(Refusal::internal("a file fetch did not finish").into()))
}

async fn attempt(
    app: &Arc<App>,
    caller: &Caller,
    url: &Url,
    mime_hint: Option<String>,
) -> Result<Fetched, Failed> {
    let live = app.settings.live();
    if !live.get(MCP_FETCH_ENABLED) {
        return Err(Failed::Not(Reason::Disabled));
    }
    if live.get(RATE_LIMIT_ENABLED) {
        let lane = Lane::credential(
            FILE_FETCHES,
            &caller.credential_handle(),
            PER_WINDOW,
            live.get(RATE_LIMIT_WINDOW_MS),
        );
        if let Some(wait) = app.limiter.admit(app.clock.now_ms(), &[lane]) {
            return Err(Failed::Not(Reason::RateLimited(retry_seconds(wait))));
        }
    }
    let permit = app
        .mcp
        .fetches
        .clone()
        .try_acquire_owned()
        .map_err(|_| Failed::Not(Reason::Busy))?;
    app.check_upload(caller).await?;
    let limits = Limits {
        max_bytes: live.get(MCP_FETCH_MAX_BYTES),
        time: Duration::from_millis(live.get(MCP_FETCH_TIMEOUT_MS)),
    };
    let (app, caller, url) = (app.clone(), caller.clone(), url.clone());
    let handle = Handle::current();
    let joined = tokio::task::spawn_blocking(move || {
        let outcome = stream(&app, &handle, &caller, &url, mime_hint, &limits);
        drop(permit);
        outcome
    })
    .await;
    joined.unwrap_or_else(|_| Err(Refusal::internal("a file fetch did not finish").into()))
}

async fn record(
    app: &App,
    caller: &Caller,
    raw: &str,
    url: Option<&Url>,
    outcome: &Result<Fetched, Failed>,
) {
    let mut details = audited(raw, url);
    if let Some(entries) = details.as_object_mut() {
        let (word, extra) = match outcome {
            Ok(fetched) => (
                "fetched",
                Some(("size_bytes", fetched.blob.size_bytes.into())),
            ),
            Err(Failed::Not(reason)) => (
                reason.word(),
                match reason {
                    Reason::Status(status) => Some(("status", (*status).into())),
                    _ => None,
                },
            ),
            Err(Failed::Refused(_)) => ("error", None),
        };
        entries.insert("outcome".to_string(), word.into());
        if let Some((name, value)) = extra {
            entries.insert(name.to_string(), value);
        }
    }
    let written = app
        .audit_attempt(caller, "mcp.file_fetch", "url", details)
        .await;
    if written.is_err() {
        tracing::warn!("A tool's file fetch could not be written to the audit log");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_a_plain_public_style_address() {
        assert!(checked("http://files.example/a.pdf").is_ok());
        assert!(checked("https://files.example:8443/a?x=1").is_ok());
        for bad in [
            "ftp://files.example/a",
            "file:///etc/passwd",
            "http://user:secret@files.example/a",
            "http://",
            "not an address",
        ] {
            assert_eq!(checked(bad).unwrap_err(), Reason::BadUrl, "{bad}");
        }
    }

    #[test]
    fn names_a_file_after_what_the_host_says_without_a_directory() {
        assert_eq!(
            file_name_in("attachment; filename=\"minutes.pdf\"").as_deref(),
            Some("minutes.pdf")
        );
        assert_eq!(
            file_name_in("inline; filename=../../etc/passwd").as_deref(),
            Some("passwd")
        );
        assert_eq!(file_name_in("attachment"), None);
        assert_eq!(file_name_in("attachment; filename=\"\""), None);
    }

    #[test]
    fn writes_an_address_to_the_log_as_lengths_and_a_hash() {
        let url = Url::parse("http://audit.test:8080/agenda.txt?signature=secret").unwrap();
        let logged = audited(url.as_str(), Some(&url));
        assert_eq!(logged["host"], "audit.test:8080");
        assert_eq!(logged["path_length"], "/agenda.txt".len());
        assert_eq!(logged["query_length"], "signature=secret".len());
        assert!(!logged.to_string().contains("secret"));
        assert!(!logged.to_string().contains("agenda"));
    }
}
