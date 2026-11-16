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

#[derive(Debug)]
pub struct PublicOnly {
    pub connect_timeout: Duration,
}

impl HttpConnector for PublicOnly {
    fn connect(&self, _options: &ClientOptions) -> object_store::Result<HttpClient> {
        let client = client(self.connect_timeout, Arc::new(PublicNames)).map_err(|error| {
            object_store::Error::Generic {
                store: "S3",
                source: Box::new(error),
            }
        })?;
        Ok(HttpClient::new(LiteralsJudged(client)))
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

/// The resolver is never asked about a host written as an address.
#[derive(Debug)]
struct LiteralsJudged(reqwest::Client);

#[async_trait]
impl HttpService for LiteralsJudged {
    async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let literal = request.uri().host().and_then(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .ok()
        });
        if literal.is_some_and(|ip| !is_public(ip)) {
            return Err(HttpError::new(HttpErrorKind::Unknown, not_public()));
        }
        self.0.call(request).await
    }
}

/// Any answer that is not public refuses the whole name, as for a webhook.
#[derive(Debug)]
struct PublicNames;

impl Resolve for PublicNames {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::task::spawn_blocking(move || {
                (host.as_str(), 0).to_socket_addrs().map(Iterator::collect)
            })
            .await
            .map_err(io::Error::other)??;
            if found.is_empty() || found.iter().any(|at| !is_public(at.ip())) {
                return Err(not_public().into());
            }
            Ok(Box::new(found.into_iter()) as Addrs)
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
}
