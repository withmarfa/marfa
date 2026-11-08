//! The one way the server reaches an address someone else named. A name is looked up once,
//! every answer is checked, and the socket connects to an address that was checked, so no
//! second lookup can move it. What goes wrong is told without the address or the port.

pub mod address;

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE, HOST, RETRY_AFTER};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use url::{Host, Url};

use super::faults::Faults;

/// How long one lookup may take before the name counts as not found.
pub const LOOKUP_BOUND: Duration = Duration::from_secs(3);

/// The address a check judged, and the one the socket connects to. They differ only when a
/// test fault scripts the lookup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub checked: IpAddr,
    pub connected: IpAddr,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reach {
    Targets(Vec<Target>),
    /// The name did not resolve, or not in time.
    Unresolved,
    NotPublic,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Answered {
        status: u16,
        retry_after: Option<String>,
    },
    Unreachable,
    TimedOut,
}

pub struct Outgoing<'a> {
    pub headers: &'a [(&'a str, String)],
    pub body: String,
}

/// Every lookup the server makes of a name it is given goes through here, so a `resolve` fault
/// answers it and counts it.
pub async fn look_up(faults: &Faults, host: &str, port: u16) -> Option<Vec<Target>> {
    if let Some(answer) = faults.scripted_answer(host) {
        return Some(
            answer
                .into_iter()
                .map(|(checked, connected)| Target { checked, connected })
                .collect(),
        );
    }
    let found = tokio::time::timeout(LOOKUP_BOUND, tokio::net::lookup_host((host, port)))
        .await
        .ok()?
        .ok()?;
    let targets: Vec<Target> = found
        .map(|socket| Target {
            checked: socket.ip(),
            connected: socket.ip(),
        })
        .collect();
    (!targets.is_empty()).then_some(targets)
}

/// Where `url` leads, judged once. Any answer that is not public refuses the whole name.
pub async fn reach(faults: &Faults, url: &Url, private_allowed: bool) -> Reach {
    let Some(port) = url.port_or_known_default() else {
        return Reach::Unresolved;
    };
    let targets = match url.host() {
        Some(Host::Ipv4(ip)) => vec![literal(IpAddr::V4(ip))],
        Some(Host::Ipv6(ip)) => vec![literal(IpAddr::V6(ip))],
        Some(Host::Domain(name)) => match look_up(faults, name, port).await {
            Some(targets) => targets,
            None => return Reach::Unresolved,
        },
        None => return Reach::Unresolved,
    };
    if !private_allowed
        && targets
            .iter()
            .any(|target| !address::is_public(target.checked))
    {
        return Reach::NotPublic;
    }
    Reach::Targets(targets)
}

fn literal(ip: IpAddr) -> Target {
    Target {
        checked: ip,
        connected: ip,
    }
}

static TLS: LazyLock<Option<Arc<ClientConfig>>> = LazyLock::new(|| {
    let built =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .and_then(|builder| builder.with_platform_verifier());
    match built {
        Ok(builder) => {
            let mut config = builder.with_no_client_auth();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Some(Arc::new(config))
        }
        Err(error) => {
            tracing::error!(error = %error, "The system's certificate store could not be read");
            None
        }
    }
});

/// Posts once to one of `targets`, and takes the answer's status without following it anywhere.
/// The whole attempt, connecting included, ends at `bound`.
pub async fn post(
    url: &Url,
    targets: &[Target],
    outgoing: Outgoing<'_>,
    bound: Duration,
) -> Outcome {
    tokio::time::timeout(bound, attempt(url, targets, outgoing))
        .await
        .unwrap_or(Outcome::TimedOut)
}

async fn attempt(url: &Url, targets: &[Target], outgoing: Outgoing<'_>) -> Outcome {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Outcome::Unreachable;
    };
    let mut stream = None;
    for target in targets {
        if let Ok(connected) = TcpStream::connect(SocketAddr::new(target.connected, port)).await {
            stream = Some(connected);
            break;
        }
    }
    let Some(stream) = stream else {
        return Outcome::Unreachable;
    };
    let _ = stream.set_nodelay(true);
    let Ok(request) = request(url, host, outgoing) else {
        return Outcome::Unreachable;
    };
    if url.scheme() != "https" {
        return exchange(stream, request).await;
    }
    let (Some(config), Some(name)) = (TLS.as_ref(), server_name(url)) else {
        return Outcome::Unreachable;
    };
    match TlsConnector::from(config.clone())
        .connect(name, stream)
        .await
    {
        Ok(secured) => exchange(secured, request).await,
        Err(_) => Outcome::Unreachable,
    }
}

fn server_name(url: &Url) -> Option<ServerName<'static>> {
    match url.host()? {
        Host::Domain(name) => ServerName::try_from(name.to_string()).ok(),
        Host::Ipv4(ip) => Some(ServerName::IpAddress(IpAddr::V4(ip).into())),
        Host::Ipv6(ip) => Some(ServerName::IpAddress(IpAddr::V6(ip).into())),
    }
}

fn request(
    url: &Url,
    host: &str,
    outgoing: Outgoing<'_>,
) -> hyper::http::Result<Request<Full<Bytes>>> {
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let target = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(target)
        .header(HOST, authority)
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_LENGTH, outgoing.body.len());
    for (name, value) in outgoing.headers {
        builder = builder.header(*name, value);
    }
    builder.body(Full::new(Bytes::from(outgoing.body)))
}

async fn exchange<S>(stream: S, request: Request<Full<Bytes>>) -> Outcome
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        return Outcome::Unreachable;
    };
    let mut connection = std::pin::pin!(connection);
    let mut answer = std::pin::pin!(sender.send_request(request));
    // A receiver that answers and closes ends the connection as the answer arrives, and the
    // answer still counts.
    let answered = tokio::select! {
        biased;
        answered = &mut answer => answered,
        _ = &mut connection => answer.await,
    };
    match answered {
        Ok(response) => Outcome::Answered {
            status: response.status().as_u16(),
            retry_after: response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        },
        Err(_) => Outcome::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// A receiver on loopback that reads one request and then does what `answer` says.
    async fn receiver<F, Fut>(answer: F) -> (Url, tokio::task::JoinHandle<String>)
    where
        F: FnOnce(TcpStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = String> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            answer(stream).await
        });
        (
            Url::parse(&format!("http://127.0.0.1:{port}/hook?a=1")).unwrap(),
            served,
        )
    }

    async fn head(stream: &mut TcpStream) -> String {
        let mut seen = Vec::new();
        let mut byte = [0u8; 1];
        while !seen.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            seen.push(byte[0]);
        }
        String::from_utf8(seen).unwrap()
    }

    fn loopback() -> Vec<Target> {
        vec![literal("127.0.0.1".parse().unwrap())]
    }

    async fn send(url: &Url, targets: &[Target], bound: Duration) -> Outcome {
        let headers = [("x-marfa-event-type", "item.created".to_string())];
        let outgoing = Outgoing {
            headers: &headers,
            body: "{}".to_string(),
        };
        post(url, targets, outgoing, bound).await
    }

    #[tokio::test]
    async fn takes_the_status_and_retry_after_and_follows_no_redirect() {
        let (url, served) = receiver(|mut stream| async move {
            let request = head(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/\r\nRetry-After: 4\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
            request
        })
        .await;
        let outcome = send(&url, &loopback(), Duration::from_secs(5)).await;
        assert_eq!(
            outcome,
            Outcome::Answered {
                status: 307,
                retry_after: Some("4".into())
            }
        );
        let request = served.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /hook?a=1 http/1.1"), "{request}");
        assert!(request.contains(&format!("host: 127.0.0.1:{}", url.port().unwrap())));
        assert!(request.contains("content-type: application/json"));
        assert!(request.contains("x-marfa-event-type: item.created"));
    }

    #[tokio::test]
    async fn a_receiver_that_closes_mid_body_has_still_answered() {
        let (url, _served) = receiver(|mut stream| async move {
            head(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc")
                .await
                .unwrap();
            String::new()
        })
        .await;
        let outcome = send(&url, &loopback(), Duration::from_secs(5)).await;
        assert!(matches!(outcome, Outcome::Answered { status: 200, .. }));
    }

    #[tokio::test]
    async fn a_receiver_that_closes_before_answering_is_unreachable() {
        let (url, _served) = receiver(|mut stream| async move {
            head(&mut stream).await;
            String::new()
        })
        .await;
        let outcome = send(&url, &loopback(), Duration::from_secs(5)).await;
        assert_eq!(outcome, Outcome::Unreachable);
    }

    #[tokio::test]
    async fn a_receiver_that_hangs_is_cut_at_the_bound() {
        let (url, _served) = receiver(|mut stream| async move {
            head(&mut stream).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            String::new()
        })
        .await;
        let started = Instant::now();
        let outcome = send(&url, &loopback(), Duration::from_millis(300)).await;
        assert_eq!(outcome, Outcome::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_receiver_that_answers_slowly_within_the_bound_is_taken() {
        let (url, _served) = receiver(|mut stream| async move {
            head(&mut stream).await;
            tokio::time::sleep(Duration::from_millis(400)).await;
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await
                .unwrap();
            String::new()
        })
        .await;
        let started = Instant::now();
        let outcome = send(&url, &loopback(), Duration::from_secs(5)).await;
        assert!(
            matches!(outcome, Outcome::Answered { status: 204, .. }),
            "{outcome:?}"
        );
        assert!(started.elapsed() >= Duration::from_millis(400));
    }

    #[tokio::test]
    async fn a_port_nobody_listens_on_is_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(
            send(&url, &loopback(), Duration::from_secs(5)).await,
            Outcome::Unreachable
        );
    }

    #[tokio::test]
    async fn connects_to_the_address_it_checked_without_a_second_lookup() {
        let faults = Faults::default();
        faults
            .set("resolve:rebind.test", Some("93.184.216.34>127.0.0.1;::1"))
            .unwrap();
        let (local, served) = receiver(|mut stream| async move {
            let request = head(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await
                .unwrap();
            request
        })
        .await;
        let url = Url::parse(&format!("http://rebind.test:{}/", local.port().unwrap())).unwrap();
        let Reach::Targets(targets) = reach(&faults, &url, false).await else {
            panic!("the first answer is public");
        };
        let outcome = send(&url, &targets, Duration::from_secs(5)).await;
        assert!(matches!(outcome, Outcome::Answered { status: 204, .. }));
        assert!(
            served
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("host: rebind.test:")
        );
        assert_eq!(faults.list()[0].fired, 1);
        assert_eq!(reach(&faults, &url, false).await, Reach::NotPublic);
    }

    #[tokio::test]
    async fn refuses_a_name_with_any_answer_that_is_not_public_unless_allowed() {
        let faults = Faults::default();
        faults
            .set("resolve:mixed.test", Some("93.184.216.34,10.0.0.1"))
            .unwrap();
        let url = Url::parse("https://mixed.test/").unwrap();
        assert_eq!(reach(&faults, &url, false).await, Reach::NotPublic);
        assert!(
            matches!(reach(&faults, &url, true).await, Reach::Targets(found) if found.len() == 2)
        );
        let literal = Url::parse("http://[::ffff:127.0.0.1]:9/").unwrap();
        assert_eq!(reach(&faults, &literal, false).await, Reach::NotPublic);
    }
}
