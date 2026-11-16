//! Requests to GitHub through public, pinned addresses, judging each redirect.

use std::fs::File;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use ureq::Agent;
use ureq::http::{Response, header};
use ureq::tls::{RootCerts, TlsConfig};
use ureq::unversioned::transport::DefaultConnector;
use url::Url;

use crate::app::faults::{Faults, ReleaseFeed};
use crate::app::outbound::{self, Asker, Pinned, Reach};

/// Where GitHub serves a release's files from, and where it redirects them to.
pub const RELEASE_HOSTS: &[&str] = &["github.com", "release-assets.githubusercontent.com"];

const MOST_HOPS: usize = 4;
const MOST_ADDRESSES: usize = 16;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Failed {
    Unaddressable,
    Unreachable,
    TimedOut,
    NotPublic,
    Status(u16),
    Redirected,
    TooLarge,
    Disk(String),
}

impl Failed {
    pub fn words(&self) -> String {
        match self {
            Failed::Unaddressable => "the address is not one this server fetches from".to_string(),
            Failed::Unreachable => "the host could not be reached".to_string(),
            Failed::TimedOut => "the host took too long to answer".to_string(),
            Failed::NotPublic => "the host is at an address that is not public".to_string(),
            Failed::Status(status) => format!("the host answered {status}"),
            Failed::Redirected => {
                "the host redirected too often, or to somewhere this server does not fetch from"
                    .to_string()
            }
            Failed::TooLarge => "the file is larger than a release's files are".to_string(),
            Failed::Disk(why) => format!("the file could not be written: {why}"),
        }
    }
}

pub struct Feed {
    faults: Arc<Faults>,
    handle: Handle,
    /// A fault named an address, which may be local and plain http.
    local: bool,
}

impl Feed {
    /// Built in the runtime; its methods block.
    pub fn new(faults: Arc<Faults>) -> Feed {
        Feed {
            local: matches!(faults.release_feed(), ReleaseFeed::At(_)),
            faults,
            handle: Handle::current(),
        }
    }

    fn admit(&self, url: &Url, hosts: Option<&[&str]>) -> Result<(), Failed> {
        let scheme = if self.local {
            matches!(url.scheme(), "http" | "https")
        } else {
            url.scheme() == "https"
        };
        let named = self.local
            || hosts.is_none_or(|hosts| url.host_str().is_some_and(|host| hosts.contains(&host)));
        let plain = scheme
            && named
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none();
        if plain {
            Ok(())
        } else {
            Err(Failed::Unaddressable)
        }
    }

    fn resolved(&self, url: &Url) -> Result<Vec<SocketAddr>, Failed> {
        let port = url.port_or_known_default().ok_or(Failed::Unaddressable)?;
        match self.handle.block_on(outbound::reach(
            &self.faults,
            url,
            self.local,
            Asker::Release,
        )) {
            Reach::Targets(targets) => Ok(targets
                .into_iter()
                .take(MOST_ADDRESSES)
                .map(|target| SocketAddr::new(target.connected, port))
                .collect()),
            Reach::Unresolved | Reach::NoSlot => Err(Failed::Unreachable),
            Reach::NotPublic => Err(Failed::NotPublic),
        }
    }

    fn open(
        &self,
        start: &Url,
        accept: &str,
        time: Duration,
        hosts: Option<&[&str]>,
    ) -> Result<Response<ureq::Body>, Failed> {
        let tls = TlsConfig::builder()
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let mut url = start.clone();
        for _ in 0..=MOST_HOPS {
            self.admit(&url, hosts)?;
            let config = Agent::config_builder()
                .https_only(!self.local)
                .proxy(None)
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(time))
                .max_response_header_size(MAX_HEADER_BYTES)
                .tls_config(tls.clone())
                .user_agent("marfa-server")
                .build();
            let agent = Agent::with_parts(
                config,
                DefaultConnector::default(),
                Pinned(self.resolved(&url)?),
            );
            let response = agent
                .get(url.as_str())
                .header(header::ACCEPT, accept)
                .header(header::ACCEPT_ENCODING, "identity")
                .call()
                .map_err(|error| match error {
                    ureq::Error::Timeout(_) => Failed::TimedOut,
                    ureq::Error::BadUri(_)
                    | ureq::Error::Http(_)
                    | ureq::Error::RequireHttpsOnly(_) => Failed::Unaddressable,
                    _ => Failed::Unreachable,
                })?;
            match response.status().as_u16() {
                200..=299 => return Ok(response),
                301 | 302 | 303 | 307 | 308 => {
                    url = response
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|location| url.join(location).ok())
                        .ok_or(Failed::Redirected)?;
                }
                status => return Err(Failed::Status(status)),
            }
        }
        Err(Failed::Redirected)
    }

    fn declared(response: &Response<ureq::Body>) -> Option<u64> {
        response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
    }

    /// Reads a document from `hosts`, or from any public host when `None`.
    pub fn document(
        &self,
        url: &Url,
        limit: u64,
        time: Duration,
        hosts: Option<&[&str]>,
    ) -> Result<Vec<u8>, Failed> {
        let mut response = self.open(url, "application/vnd.github+json", time, hosts)?;
        if Feed::declared(&response).is_some_and(|length| length > limit) {
            return Err(Failed::TooLarge);
        }
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(limit + 1)
            .read_to_end(&mut body)
            .map_err(|_| Failed::TimedOut)?;
        if body.len() as u64 > limit {
            return Err(Failed::TooLarge);
        }
        Ok(body)
    }

    /// Writes a release's file to `to`, removing it if the download fails; gives the SHA-256 as hex.
    pub fn file(&self, url: &Url, to: &Path, limit: u64, time: Duration) -> Result<String, Failed> {
        let mut response = self.open(url, "application/octet-stream", time, Some(RELEASE_HOSTS))?;
        if Feed::declared(&response).is_some_and(|length| length > limit) {
            return Err(Failed::TooLarge);
        }
        let disk = |error: std::io::Error| Failed::Disk(error.to_string());
        let mut file = File::create(to).map_err(disk)?;
        let mut hash = Sha256::new();
        let mut reader = response.body_mut().as_reader();
        let mut buffer = vec![0u8; CHUNK];
        let mut total: u64 = 0;
        let ended = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(count) => {
                    total += count as u64;
                    if total > limit {
                        break Err(Failed::TooLarge);
                    }
                    hash.update(&buffer[..count]);
                    if let Err(error) = file.write_all(&buffer[..count]) {
                        break Err(disk(error));
                    }
                }
                Err(_) => break Err(Failed::TimedOut),
            }
        };
        let ended = ended.and_then(|()| file.sync_all().map_err(disk));
        if let Err(failed) = ended {
            drop(file);
            let _ = std::fs::remove_file(to);
            return Err(failed);
        }
        Ok(hex::encode(hash.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_release_file_comes_only_from_github_and_its_asset_host_over_https() {
        let feed = Feed::new(Arc::default());
        let release = Some(RELEASE_HOSTS);
        for allowed in [
            "https://github.com/withmarfa/marfa/releases/download/v0.0.75/a.tar.gz",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/2",
        ] {
            assert_eq!(feed.admit(&url(allowed), release), Ok(()), "{allowed}");
        }
        for refused in [
            "https://example.com/a.tar.gz",
            "https://github.com.example.com/a.tar.gz",
            "https://evilgithub.com/a.tar.gz",
            "https://objects.githubusercontent.com/a",
            "https://user@github.com/a.tar.gz",
            "http://github.com/a.tar.gz",
            "https://203.0.113.9/a.tar.gz",
        ] {
            assert_eq!(
                feed.admit(&url(refused), release),
                Err(Failed::Unaddressable),
                "{refused}"
            );
        }
        assert_eq!(
            feed.admit(&url("https://example.com/latest"), None),
            Ok(()),
            "the witness: with no host named any public https address is admitted"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_release_file_from_another_host_is_refused_before_anything_is_fetched_or_written() {
        let feed = Feed::new(Arc::default());
        let to = std::env::temp_dir().join(format!("marfa-feed-{}", std::process::id()));
        let _ = std::fs::remove_file(&to);
        let refused = feed.file(
            &url("https://example.com/a.tar.gz"),
            &to,
            1 << 20,
            Duration::from_secs(5),
        );
        assert_eq!(refused, Err(Failed::Unaddressable));
        assert!(!to.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_fault_that_names_an_address_is_admitted_whatever_its_host() {
        let faults = Arc::new(Faults::default());
        faults
            .set("release-feed", Some("http://127.0.0.1:9/latest"))
            .unwrap();
        let feed = Feed::new(faults);
        assert_eq!(
            feed.admit(&url("http://127.0.0.1:9/a"), Some(RELEASE_HOSTS)),
            Ok(())
        );
    }
}
