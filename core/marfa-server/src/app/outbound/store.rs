//! Object store connections that reach only public addresses, never through a proxy.

use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use object_store::ClientOptions;
use object_store::client::{
    HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest, HttpResponse, HttpService,
};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

use super::address::is_public;
use crate::app::faults::Faults;

#[derive(Debug)]
pub struct PublicOnly {
    pub connect_timeout: Duration,
    pub faults: Arc<Faults>,
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
        Ok(HttpClient::new(RequestsJudged(client)))
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

fn not_public() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the object store's address is not public, and allow_private_addresses is false",
    )
}

/// Holds each request to the destination address rules.
#[derive(Debug)]
struct RequestsJudged(reqwest::Client);

fn judged(uri: &http::Uri) -> Result<(), io::Error> {
    let url = url::Url::parse(&uri.to_string()).map_err(|_| not_public())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(not_public());
    }
    let literal = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => None,
        None => return Err(not_public()),
    };
    if literal.is_some_and(|ip| !is_public(ip)) {
        return Err(not_public());
    }
    Ok(())
}

#[async_trait]
impl HttpService for RequestsJudged {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        judged(request.uri()).map_err(|error| HttpError::new(HttpErrorKind::Unknown, error))?;
        self.0.call(request).await
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
                return Err(not_public().into());
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
        let service = RequestsJudged(
            client(
                Duration::from_secs(2),
                Arc::new(PublicNames(Arc::default())),
            )
            .unwrap(),
        );
        // The witness: the listener does take a connection when nothing refuses it.
        let _ = service
            .0
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
        let (mut fit, mut refused) = (0, 0);
        for (url, read) in hosts("0127fx.", 6, 9000) {
            let public = match read {
                Some(url::Host::Ipv4(ip)) => is_public(IpAddr::V4(ip)),
                Some(url::Host::Ipv6(ip)) => is_public(IpAddr::V6(ip)),
                Some(url::Host::Domain(_)) => true,
                None => false,
            };
            let judged = judged(&url.parse().unwrap()).is_ok();
            assert_eq!(judged, public, "{url}");
            if judged {
                fit += 1;
            } else {
                refused += 1;
            }
        }
        assert!(fit > 0 && refused > 0, "{fit} fit, {refused} refused");
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
            assert!(judged(&url.parse().unwrap()).is_ok(), "{url}");
        }
        for url in [
            "http://10.0.0.1/b",
            "http://169.254.169.254/b",
            "http://192.168.1.1/b",
            "http://[fe80::1]/b",
        ] {
            assert!(judged(&url.parse().unwrap()).is_err(), "{url}");
        }
    }
}
