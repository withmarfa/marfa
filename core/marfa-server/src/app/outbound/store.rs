//! The object store's connections while private addresses are not allowed: each goes straight
//! to a public address its own lookup found, never through a proxy.

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
        let client = reqwest::Client::builder()
            .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(self.connect_timeout)
            .no_proxy()
            // A decoded body would not match the `Content-Length` the store reads sizes from.
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .dns_resolver(Arc::new(PublicNames))
            .build()
            .map_err(|error| object_store::Error::Generic {
                store: "S3",
                source: Box::new(error),
            })?;
        Ok(HttpClient::new(LiteralsJudged(client)))
    }
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
