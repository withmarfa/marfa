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

use super::release::DOWNLOADS;
use crate::app::faults::{Faults, ReleaseFeed};
use crate::app::outbound::{self, Asker, Pinned, Reach};

/// The hosts a request may start at, and those a redirect may lead to.
pub struct Hosts {
    first: &'static [&'static str],
    then: &'static [&'static str],
}

/// GitHub's answer about its latest release.
pub const CHECK_HOSTS: Hosts = Hosts {
    first: &["api.github.com"],
    then: &["api.github.com"],
};

/// A release's files, which GitHub redirects to its asset host.
pub const RELEASE_HOSTS: Hosts = Hosts {
    first: &["github.com"],
    then: &["release-assets.githubusercontent.com"],
};

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
    /// The origin a fault names in GitHub's place, which may be local and plain http.
    stand_in: Option<url::Origin>,
}

impl Feed {
    /// Built in the runtime; its methods block.
    pub fn new(faults: Arc<Faults>) -> Feed {
        let stand_in = match faults.release_feed() {
            ReleaseFeed::At(address) => Some(
                Url::parse(&address).map_or_else(|_| url::Origin::new_opaque(), |url| url.origin()),
            ),
            ReleaseFeed::Public | ReleaseFeed::Nowhere => None,
        };
        Feed {
            stand_in,
            faults,
            handle: Handle::current(),
        }
    }

    fn local(&self) -> bool {
        self.stand_in.is_some()
    }

    /// The origin a release's files are fetched from.
    pub fn downloads(&self) -> String {
        self.stand_in
            .as_ref()
            .map_or_else(|| DOWNLOADS.to_string(), url::Origin::ascii_serialization)
    }

    fn admit(&self, url: &Url, hosts: &[&str]) -> Result<(), Failed> {
        let (scheme, named) = match &self.stand_in {
            Some(origin) => (
                matches!(url.scheme(), "http" | "https"),
                url.origin() == *origin,
            ),
            None => (
                url.scheme() == "https",
                url.host_str().is_some_and(|host| hosts.contains(&host)),
            ),
        };
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
            self.local(),
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
        hosts: &Hosts,
    ) -> Result<Response<ureq::Body>, Failed> {
        let tls = TlsConfig::builder()
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let mut url = start.clone();
        for hop in 0..=MOST_HOPS {
            if hop == 0 {
                self.admit(&url, hosts.first)?;
            } else {
                self.admit(&url, hosts.then)
                    .map_err(|_| Failed::Redirected)?;
            }
            let config = Agent::config_builder()
                .https_only(!self.local())
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

    pub fn document(
        &self,
        url: &Url,
        limit: u64,
        time: Duration,
        hosts: &Hosts,
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
        let mut response = self.open(url, "application/octet-stream", time, &RELEASE_HOSTS)?;
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_release_file_starts_at_github_and_is_redirected_only_to_its_asset_host() {
        let feed = Feed::new(Arc::default());
        let (first, then) = (RELEASE_HOSTS.first, RELEASE_HOSTS.then);
        let github = "https://github.com/withmarfa/marfa/releases/download/v0.0.75/a.tar.gz";
        let assets =
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/2";
        assert_eq!(feed.admit(&url(github), first), Ok(()));
        assert_eq!(feed.admit(&url(assets), then), Ok(()));
        assert_eq!(feed.admit(&url(assets), first), Err(Failed::Unaddressable));
        assert_eq!(feed.admit(&url(github), then), Err(Failed::Unaddressable));
        for refused in [
            "https://example.com/a.tar.gz",
            "https://github.com.example.com/a.tar.gz",
            "https://evilgithub.com/a.tar.gz",
            "https://objects.githubusercontent.com/a",
            "https://api.github.com/a",
            "https://user@github.com/a.tar.gz",
            "http://github.com/a.tar.gz",
            "https://203.0.113.9/a.tar.gz",
        ] {
            for hosts in [first, then] {
                assert_eq!(
                    feed.admit(&url(refused), hosts),
                    Err(Failed::Unaddressable),
                    "{refused}"
                );
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_release_check_asks_only_githubs_api_host_at_every_hop() {
        let feed = Feed::new(Arc::default());
        let latest = url("https://api.github.com/repos/withmarfa/marfa/releases/latest");
        for hosts in [CHECK_HOSTS.first, CHECK_HOSTS.then] {
            assert_eq!(feed.admit(&latest, hosts), Ok(()));
            for refused in [
                "https://example.com/latest",
                "https://github.com/withmarfa/marfa/releases/latest",
                "https://api.github.com.example.com/latest",
                "http://api.github.com/latest",
            ] {
                assert_eq!(
                    feed.admit(&url(refused), hosts),
                    Err(Failed::Unaddressable),
                    "{refused}"
                );
            }
        }
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
    async fn githubs_hosts_are_reached_only_at_public_addresses() {
        let faults = Arc::new(Faults::default());
        faults
            .set("resolve:api.github.com", Some("127.0.0.1"))
            .unwrap();
        let feed = Arc::new(Feed::new(faults.clone()));
        let ask = |feed: Arc<Feed>| async move {
            tokio::task::spawn_blocking(move || {
                let latest = url("https://api.github.com/repos/withmarfa/marfa/releases/latest");
                feed.document(&latest, 1024, Duration::from_secs(5), &CHECK_HOSTS)
            })
            .await
            .unwrap()
        };
        assert_eq!(ask(feed.clone()).await, Err(Failed::NotPublic));
        faults
            .set("resolve:api.github.com", Some("93.184.216.34>127.0.0.1"))
            .unwrap();
        assert_ne!(
            ask(feed).await,
            Err(Failed::NotPublic),
            "the witness: judged public, the same name is asked"
        );
    }

    /// Answers every request with a redirect to `to`, keeping the paths it was asked.
    fn redirecting(to: impl Fn(u16) -> String + Send + 'static) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut head = [0u8; 2048];
                let read = stream.read(&mut head).unwrap_or(0);
                let head = String::from_utf8_lossy(&head[..read]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                kept.lock().unwrap().push(path);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        to(port)
                    )
                    .as_bytes(),
                );
            }
        });
        (port, asked)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_fault_stands_in_for_github_and_a_redirect_off_its_origin_is_not_followed() {
        let (port, asked) = redirecting(|port| format!("http://localhost:{port}/elsewhere"));
        let faults = Arc::new(Faults::default());
        let latest = format!("http://127.0.0.1:{port}/latest");
        faults.set("release-feed", Some(&latest)).unwrap();
        let feed = Feed::new(faults);
        assert_eq!(feed.downloads(), format!("http://127.0.0.1:{port}"));
        assert_eq!(feed.admit(&url(&latest), RELEASE_HOSTS.first), Ok(()));
        for refused in [
            format!("http://localhost:{port}/latest"),
            format!("http://127.0.0.1:{}/latest", port.wrapping_add(1)),
            "https://github.com/withmarfa/marfa/releases/download/v0.0.75/a".to_string(),
        ] {
            assert_eq!(
                feed.admit(&url(&refused), RELEASE_HOSTS.first),
                Err(Failed::Unaddressable),
                "{refused}"
            );
        }
        let followed = tokio::task::spawn_blocking(move || {
            feed.document(&url(&latest), 1024, Duration::from_secs(5), &CHECK_HOSTS)
        })
        .await
        .unwrap();
        assert_eq!(followed, Err(Failed::Redirected));
        assert_eq!(*asked.lock().unwrap(), vec!["/latest".to_string()]);

        let (port, asked) = redirecting(|port| format!("http://127.0.0.1:{port}/again"));
        let faults = Arc::new(Faults::default());
        let latest = format!("http://127.0.0.1:{port}/latest");
        faults.set("release-feed", Some(&latest)).unwrap();
        let feed = Feed::new(faults);
        let followed = tokio::task::spawn_blocking(move || {
            feed.document(&url(&latest), 1024, Duration::from_secs(5), &CHECK_HOSTS)
        })
        .await
        .unwrap();
        assert_eq!(followed, Err(Failed::Redirected));
        assert!(
            asked.lock().unwrap().len() > 1,
            "the witness: a redirect on the same origin is followed"
        );
    }
}
