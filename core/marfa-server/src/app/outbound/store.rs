//! Object store connections that reach only public addresses, never through a proxy.

use std::error::Error;
use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use object_store::ClientOptions;
use object_store::client::{
    HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest, HttpResponse, HttpService,
};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use super::address::is_public;
use crate::app::faults::Faults;

/// Where the store's credentials are fetched from when no access key and secret are set.
pub const METADATA_ENDPOINT: &str = "http://169.254.169.254";
const METADATA_HOST: &str = "169.254.169.254";

/// Which request to the object store the address rules refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// A request to the host the store is addressed at.
    Bucket,
    /// The fetch of the store's credentials.
    Credentials,
}

impl Refused {
    /// Why, in words that name no address or key.
    pub fn reason(self) -> &'static str {
        match self {
            Refused::Bucket => {
                "the object store's address is not public, and allow_private_addresses is false"
            }
            Refused::Credentials => {
                "the address the object store's credentials are fetched from is not public, and \
                 allow_private_addresses is false; set an access key and secret, or turn \
                 allow_private_addresses on"
            }
        }
    }

    /// The refusal anywhere in `error`'s chain, an `io::Error`'s own error included.
    pub fn in_chain(error: &(dyn Error + 'static)) -> Option<Refused> {
        let mut cause = Some(error);
        while let Some(error) = cause {
            if let Some(refused) = error.downcast_ref::<Refused>() {
                return Some(*refused);
            }
            if let Some(inner) = error
                .downcast_ref::<io::Error>()
                .and_then(io::Error::get_ref)
                && let Some(refused) = Refused::in_chain(inner)
            {
                return Some(refused);
            }
            cause = error.source();
        }
        None
    }

    /// The request `uri` makes to the store.
    fn of(uri: &http::Uri) -> Refused {
        match uri.host() {
            Some(METADATA_HOST) => Refused::Credentials,
            _ => Refused::Bucket,
        }
    }
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}

impl Error for Refused {}

/// What the address rules said of the last request of each kind to one object store.
#[derive(Debug, Default)]
pub struct Guarded {
    bucket: AtomicBool,
    credentials: AtomicBool,
}

impl Guarded {
    /// The refusal that holds now; the store's own requests wait on its credentials.
    pub fn refused(&self) -> Option<Refused> {
        if self.credentials.load(Ordering::SeqCst) {
            Some(Refused::Credentials)
        } else if self.bucket.load(Ordering::SeqCst) {
            Some(Refused::Bucket)
        } else {
            None
        }
    }

    fn note(&self, request: Refused, refused: bool) {
        let flag = match request {
            Refused::Bucket => &self.bucket,
            Refused::Credentials => &self.credentials,
        };
        flag.store(refused, Ordering::SeqCst);
    }
}

#[derive(Debug)]
pub struct PublicOnly {
    pub connect_timeout: Duration,
    pub faults: Arc<Faults>,
    pub guarded: Arc<Guarded>,
}

impl HttpConnector for PublicOnly {
    fn connect(&self, _options: &ClientOptions) -> object_store::Result<HttpClient> {
        let client = client(
            self.connect_timeout,
            Arc::new(PublicNames(self.faults.clone())),
        )
        .map_err(|error| object_store::Error::Generic {
            store: "S3",
            source: Box::new(error),
        })?;
        Ok(HttpClient::new(RequestsJudged {
            client,
            guarded: self.guarded.clone(),
        }))
    }
}

/// A redirect would reach its address unjudged, so a `3xx` is answered to the store as it came.
fn client(connect_timeout: Duration, names: Arc<dyn Resolve>) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(connect_timeout)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        // A decoded body would not match the `Content-Length` the store reads sizes from.
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .dns_resolver(names)
        .build()
}

/// Holds each request to the destination address rules, and notes what they said.
#[derive(Debug)]
struct RequestsJudged {
    client: reqwest::Client,
    guarded: Arc<Guarded>,
}

/// Whether `uri` may be asked before its host is looked up.
fn fit(uri: &http::Uri) -> bool {
    let Ok(url) = url::Url::parse(&uri.to_string()) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => is_public(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_public(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => true,
        None => false,
    }
}

#[async_trait]
impl HttpService for RequestsJudged {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let asked = Refused::of(request.uri());
        if !fit(request.uri()) {
            self.guarded.note(asked, true);
            return Err(HttpError::new(HttpErrorKind::Unknown, asked));
        }
        let answer = self.client.call(request).await;
        let refused = answer
            .as_ref()
            .is_err_and(|error| Refused::in_chain(error).is_some());
        self.guarded.note(asked, refused);
        answer
    }
}

/// Any answer that is not public refuses the whole name, as for a webhook. A lookup the resolver
/// fault scripts is judged by the addresses it names to be judged.
#[derive(Debug)]
struct PublicNames(Arc<Faults>);

impl Resolve for PublicNames {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let scripted = self.0.resolve(&host);
        Box::pin(async move {
            let (judged, reached): (Vec<IpAddr>, Vec<SocketAddr>) = match scripted {
                Some(scripted) => (
                    scripted.judged,
                    scripted
                        .reached
                        .into_iter()
                        .map(|ip| SocketAddr::new(ip, 0))
                        .collect(),
                ),
                None => {
                    let found: Vec<SocketAddr> = tokio::task::spawn_blocking(move || {
                        (host.as_str(), 0).to_socket_addrs().map(Iterator::collect)
                    })
                    .await
                    .map_err(io::Error::other)??;
                    (found.iter().map(SocketAddr::ip).collect(), found)
                }
            };
            if reached.is_empty() || judged.is_empty() || judged.iter().any(|ip| !is_public(*ip)) {
                return Err(Refused::Bucket.into());
            }
            Ok(Box::new(reached.into_iter()) as Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// Says every name is the loopback address, as a public name an attacker controls could.
    struct Everywhere(SocketAddr);

    impl Resolve for Everywhere {
        fn resolve(&self, _: Name) -> Resolving {
            let at = self.0;
            Box::pin(async move { Ok(Box::new(std::iter::once(at)) as Addrs) })
        }
    }

    #[tokio::test]
    async fn a_redirect_from_the_store_is_never_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        let private_hits = Arc::new(AtomicUsize::new(0));
        let hits = private_hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut asked = vec![0u8; 4096];
                let read = socket.read(&mut asked).await.unwrap_or(0);
                let answer = if String::from_utf8_lossy(&asked[..read]).starts_with("GET /secret") {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\nsecret"
                        .to_string()
                } else {
                    format!(
                        "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:{}/secret\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                        at.port()
                    )
                };
                let _ = socket.write_all(answer.as_bytes()).await;
            }
        });
        let client = client(Duration::from_secs(5), Arc::new(Everywhere(at))).unwrap();
        let direct = client
            .get(format!("http://store.example.com:{}/secret", at.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(
            direct.status(),
            200,
            "the witness: the private answer is reachable"
        );
        assert_eq!(private_hits.swap(0, Ordering::SeqCst), 1);
        let redirected = client
            .get(format!("http://store.example.com:{}/bucket/key", at.port()))
            .send()
            .await
            .unwrap();
        assert_eq!(redirected.status(), 302);
        assert_eq!(private_hits.load(Ordering::SeqCst), 0);
    }

    /// Counts each connection made to a loopback listener, and answers none.
    async fn counted_listener() -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let seen = connections.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        (at, connections)
    }

    fn get(url: &str) -> HttpRequest {
        http::Request::get(url)
            .body(object_store::client::HttpRequestBody::empty())
            .unwrap()
    }

    /// Every valid host of up to `longest` characters over `alphabet`, as a URL to `port`.
    fn hosts(alphabet: &str, longest: u32, port: u16) -> Vec<(String, Option<url::Host>)> {
        let mut grown = vec![String::new()];
        let mut found = Vec::new();
        for _ in 0..longest {
            grown = grown
                .iter()
                .flat_map(|host| alphabet.chars().map(move |c| format!("{host}{c}")))
                .collect();
            for host in &grown {
                let url = format!("http://{host}:{port}/b/k");
                if url.parse::<http::Uri>().is_ok() {
                    let read = url::Url::parse(&url)
                        .ok()
                        .and_then(|url| url.host().map(|host| host.to_owned()));
                    found.push((url, read));
                }
            }
        }
        found
    }

    fn is_loopback(read: &Option<url::Host>) -> bool {
        match read {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        }
    }

    #[tokio::test]
    async fn a_request_to_a_loopback_host_is_refused_before_any_connection() {
        let (at, connections) = counted_listener().await;
        let port = at.port();
        let service = judging(Arc::new(PublicNames(Arc::default())));
        // The witness: the listener does take a connection when nothing refuses it.
        let _ = service
            .client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(connections.swap(0, Ordering::SeqCst), 1);
        let loopback: Vec<String> = hosts("0127fx.", 6, port)
            .into_iter()
            .filter(|(_, read)| is_loopback(read))
            .map(|(url, _)| url)
            .chain([
                format!("http://127.0.0.1:{port}/b/k"),
                format!("http://[::1]:{port}/b/k"),
                format!("http://localhost:{port}/b/k"),
            ])
            .collect();
        assert!(loopback.len() > 3, "{loopback:?}");
        for url in loopback {
            assert!(service.call(get(&url)).await.is_err(), "{url}");
        }
        for url in [
            format!("http://user@127.0.0.1:{port}/b"),
            format!("http://user:pass@store.example.com:{port}/b"),
            format!("http://user@store.example.com:{port}/b"),
        ] {
            assert!(service.call(get(&url)).await.is_err(), "{url}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(connections.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_host_is_judged_by_its_address() {
        let (mut fits, mut refused) = (0, 0);
        for (url, read) in hosts("0127fx.", 6, 9000) {
            let public = match read {
                Some(url::Host::Ipv4(ip)) => is_public(IpAddr::V4(ip)),
                Some(url::Host::Ipv6(ip)) => is_public(IpAddr::V6(ip)),
                Some(url::Host::Domain(_)) => true,
                None => false,
            };
            let judged = fit(&url.parse().unwrap());
            assert_eq!(judged, public, "{url}");
            if judged {
                fits += 1;
            } else {
                refused += 1;
            }
        }
        assert!(fits > 0 && refused > 0, "{fits} fit, {refused} refused");
    }

    #[test]
    fn a_public_name_and_a_public_address_are_judged_fit() {
        for url in [
            "https://s3.us-east-1.amazonaws.com/bucket/key",
            "https://bucket.s3.eu-west-2.amazonaws.com/key",
            "https://abc.r2.cloudflarestorage.com/bucket",
            "https://8.8.8.8/bucket",
            "https://[2606:4700:4700::1111]/bucket",
            "http://store.example.com:9000/bucket",
        ] {
            assert!(fit(&url.parse().unwrap()), "{url}");
        }
        for url in [
            "http://10.0.0.1/b",
            "http://169.254.169.254/b",
            "http://192.168.1.1/b",
            "http://[fe80::1]/b",
        ] {
            assert!(!fit(&url.parse().unwrap()), "{url}");
        }
    }

    fn judging(names: Arc<dyn Resolve>) -> RequestsJudged {
        RequestsJudged {
            client: client(Duration::from_secs(2), names).unwrap(),
            guarded: Arc::default(),
        }
    }

    /// Answers every connection `200` with an empty body.
    async fn answering_listener() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let at = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut asked = vec![0u8; 4096];
                let _ = socket.read(&mut asked).await;
                let _ = socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .await;
            }
        });
        at
    }

    #[tokio::test]
    async fn a_refusal_names_its_request_and_holds_until_that_request_passes() {
        let service = judging(Arc::new(PublicNames(Arc::default())));
        let port = answering_listener().await.port();
        let by_lookup = service
            .call(get(&format!("http://localhost:{port}/b/k")))
            .await
            .unwrap_err();
        assert_eq!(Refused::in_chain(&by_lookup), Some(Refused::Bucket));
        assert_eq!(service.guarded.refused(), Some(Refused::Bucket));
        let credentials = service
            .call(get("http://169.254.169.254/latest/api/token"))
            .await
            .unwrap_err();
        assert_eq!(Refused::in_chain(&credentials), Some(Refused::Credentials));
        assert_eq!(service.guarded.refused(), Some(Refused::Credentials));
        let wrapped = io::Error::other(object_store::Error::Generic {
            store: "S3",
            source: Box::new(credentials),
        });
        assert_eq!(Refused::in_chain(&wrapped), Some(Refused::Credentials));

        // The same kinds of request, now let through, clear what they set.
        let passing = RequestsJudged {
            client: client(
                Duration::from_secs(2),
                Arc::new(Everywhere(SocketAddr::from(([127, 0, 0, 1], port)))),
            )
            .unwrap(),
            guarded: service.guarded.clone(),
        };
        service.guarded.note(Refused::Credentials, false);
        assert_eq!(service.guarded.refused(), Some(Refused::Bucket));
        let answer = passing
            .call(get(&format!("http://store.example.com:{port}/b/k")))
            .await
            .unwrap();
        assert_eq!(answer.status(), 200);
        assert_eq!(service.guarded.refused(), None);
    }

    #[tokio::test]
    async fn a_store_that_does_not_answer_is_not_a_refusal() {
        let service = judging(Arc::new(Everywhere(SocketAddr::from(([127, 0, 0, 1], 9)))));
        service.guarded.note(Refused::Bucket, true);
        let silent = service
            .call(get("http://store.example.com:9/b/k"))
            .await
            .unwrap_err();
        assert_eq!(Refused::in_chain(&silent), None);
        assert_eq!(service.guarded.refused(), None);
    }

    #[tokio::test]
    async fn a_client_without_keys_reports_its_credentials_refused() {
        let guarded = Arc::new(Guarded::default());
        let store = object_store::aws::AmazonS3Builder::new()
            .with_bucket_name("b")
            .with_region("us-east-1")
            .with_endpoint("http://store.example.com:9")
            .with_allow_http(true)
            .with_metadata_endpoint(METADATA_ENDPOINT)
            .with_retry(object_store::RetryConfig {
                max_retries: 0,
                ..Default::default()
            })
            .with_http_connector(PublicOnly {
                connect_timeout: Duration::from_secs(2),
                faults: Arc::default(),
                guarded: guarded.clone(),
            })
            .build()
            .unwrap();
        let failed =
            object_store::ObjectStoreExt::head(&store, &object_store::path::Path::from("k"))
                .await
                .unwrap_err();
        assert_eq!(guarded.refused(), Some(Refused::Credentials));
        assert_eq!(
            Refused::in_chain(&io::Error::from(failed)),
            Some(Refused::Credentials)
        );
    }
}
