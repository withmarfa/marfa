//! Every outbound request goes through here, to public addresses judged once.

pub mod address;
mod fair;
mod slots;
pub mod store;

pub use slots::{Asker, deliveries_released, delivery_share_is_free};
use slots::{BOUND, Lane};

use std::future::Future;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::client::conn::http1::{Connection, SendRequest};
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE, HOST, RETRY_AFTER};
use hyper::{Method, Request};
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::NextTimeout;
use url::{Host, Url};

use super::faults::Faults;

/// A timed-out lookup keeps its slot until the thread returns.
async fn resolve_with<T: Send + 'static>(
    lane: &Lane,
    maker: Option<&str>,
    lookup: impl FnOnce() -> T + Send + 'static,
    bound: Duration,
) -> Looked<T> {
    let began = tokio::time::Instant::now();
    let Some(slot) = lane.take(maker, bound).await else {
        return Looked::NoSlot;
    };
    let deadline = if lane.patient {
        tokio::time::Instant::now() + bound
    } else {
        began + bound
    };
    let thread = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        lookup()
    });
    match tokio::time::timeout_at(deadline, thread).await {
        Ok(Ok(done)) => Looked::Done(done),
        Ok(Err(_)) | Err(_) => Looked::Unfinished,
    }
}

enum Looked<T> {
    Done(T),
    /// The lookup ran past its bound, panicked or was cut.
    Unfinished,
    NoSlot,
}

/// Checked and connected addresses differ only under a test fault.
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
    /// No lookup slot came free in time, so the name was not looked up.
    NoSlot,
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

enum Lookup {
    Found(Vec<Target>),
    Unresolved,
    NoSlot,
}

/// The resolver fault counts and scripts lookups here.
async fn look_up(faults: &Faults, host: &str, port: u16, asker: Asker<'_>) -> Lookup {
    if let Some(scripted) = faults.resolve(host) {
        return Lookup::Found(
            scripted
                .judged
                .into_iter()
                .zip(scripted.reached)
                .map(|(checked, connected)| Target { checked, connected })
                .collect(),
        );
    }
    let stall = faults.stall(host);
    let name = host.to_string();
    let looked = resolve_with(
        asker.lane(),
        asker.maker(),
        move || {
            if let Some(stall) = stall {
                std::thread::sleep(stall);
            }
            (name.as_str(), port)
                .to_socket_addrs()
                .map(Iterator::collect::<Vec<_>>)
        },
        BOUND,
    )
    .await;
    let found = match looked {
        Looked::Done(Ok(found)) => found,
        Looked::Done(Err(_)) | Looked::Unfinished => return Lookup::Unresolved,
        Looked::NoSlot => return Lookup::NoSlot,
    };
    let targets: Vec<Target> = found
        .into_iter()
        .map(|socket| Target {
            checked: socket.ip(),
            connected: socket.ip(),
        })
        .collect();
    if targets.is_empty() {
        Lookup::Unresolved
    } else {
        Lookup::Found(targets)
    }
}

/// Where `url` leads, judged once. Any answer that is not public refuses the whole name.
pub async fn reach(faults: &Faults, url: &Url, private_allowed: bool, asker: Asker<'_>) -> Reach {
    let Some(port) = url.port_or_known_default() else {
        return Reach::Unresolved;
    };
    let targets = match url.host() {
        Some(Host::Ipv4(ip)) => vec![literal(IpAddr::V4(ip))],
        Some(Host::Ipv6(ip)) => vec![literal(IpAddr::V6(ip))],
        Some(Host::Domain(name)) => match look_up(faults, name, port, asker).await {
            Lookup::Found(targets) => targets,
            Lookup::Unresolved => return Reach::Unresolved,
            Lookup::NoSlot => return Reach::NoSlot,
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

/// So nothing between the check and the connection can look the name up again.
#[derive(Debug)]
pub struct Pinned(pub Vec<SocketAddr>);

impl Resolver for Pinned {
    fn resolve(
        &self,
        _uri: &Uri,
        _config: &Config,
        _timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut answers = self.empty();
        for address in &self.0 {
            answers.push(*address);
        }
        Ok(answers)
    }
}

/// Every address `url` leads to, where each is public. The lookup blocks.
fn public_addresses(url: &Url) -> Option<Vec<SocketAddr>> {
    let port = url.port_or_known_default()?;
    let found: Vec<SocketAddr> = match url.host()? {
        Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Host::Domain(name) => (name, port).to_socket_addrs().ok()?.collect(),
    };
    let public = !found.is_empty() && found.iter().all(|at| address::is_public(at.ip()));
    public.then_some(found)
}

/// `None` where private addresses are not allowed and `url` leads to one.
pub fn notice_agent(
    url: &str,
    total: Duration,
    connect: Duration,
    private_allowed: bool,
) -> Option<ureq::Agent> {
    let tls = ureq::tls::TlsConfig::builder()
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let config = ureq::Agent::config_builder()
        .tls_config(tls)
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(total))
        .timeout_connect(Some(connect))
        .user_agent(concat!("marfa-server/", env!("CARGO_PKG_VERSION")));
    if private_allowed {
        let config = if marfa_telemetry::host::may_use_proxy(url) {
            config
        } else {
            config.proxy(None)
        };
        return Some(config.build().into());
    }
    let addresses = public_addresses(&Url::parse(url).ok()?)?;
    Some(ureq::Agent::with_parts(
        config.proxy(None).build(),
        ureq::unversioned::transport::DefaultConnector::default(),
        Pinned(addresses),
    ))
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

/// Connects, then runs `check`, then sends the request only if `check` passes. The bound covers
/// connecting, the TLS handshake, `check` and the answer. Redirects are never followed.
pub async fn post<T, F>(
    url: &Url,
    targets: &[Target],
    outgoing: Outgoing<'_>,
    bound: Duration,
    check: impl FnOnce() -> F,
) -> Result<Outcome, T>
where
    F: Future<Output = Result<(), T>>,
{
    post_with(TLS.as_ref(), url, targets, outgoing, bound, check).await
}

async fn post_with<T, F>(
    tls: Option<&Arc<ClientConfig>>,
    url: &Url,
    targets: &[Target],
    outgoing: Outgoing<'_>,
    bound: Duration,
    check: impl FnOnce() -> F,
) -> Result<Outcome, T>
where
    F: Future<Output = Result<(), T>>,
{
    let Some(host) = url.host_str() else {
        return Ok(Outcome::Unreachable);
    };
    let Ok(request) = request(url, host, outgoing.headers, outgoing.body) else {
        return Ok(Outcome::Unreachable);
    };
    let deadline = tokio::time::Instant::now() + bound;
    let connected = match tokio::time::timeout_at(deadline, connect(tls, url, targets)).await {
        Ok(Some(connected)) => connected,
        Ok(None) => return Ok(Outcome::Unreachable),
        Err(_) => return Ok(Outcome::TimedOut),
    };
    // A refusal, or a check that runs past the deadline, drops the connection, which closes it
    // with nothing sent.
    match tokio::time::timeout_at(deadline, check()).await {
        Ok(passed) => passed?,
        Err(_) => return Ok(Outcome::TimedOut),
    }
    let answer = connected.send(request);
    Ok(tokio::time::timeout_at(deadline, answer)
        .await
        .unwrap_or(Outcome::TimedOut))
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> Io for S {}

/// A fresh connection, secured for HTTPS, with nothing of a request written to it.
struct Connected {
    sender: SendRequest<Full<Bytes>>,
    connection: Connection<TokioIo<Box<dyn Io>>, Full<Bytes>>,
}

async fn connect(
    tls: Option<&Arc<ClientConfig>>,
    url: &Url,
    targets: &[Target],
) -> Option<Connected> {
    let port = url.port_or_known_default()?;
    let mut stream = None;
    for target in targets {
        if let Ok(Ok(connected)) = tokio::time::timeout(
            Duration::from_secs(3),
            TcpStream::connect(SocketAddr::new(target.connected, port)),
        )
        .await
        {
            stream = Some(connected);
            break;
        }
    }
    let stream = stream?;
    let _ = stream.set_nodelay(true);
    let stream: Box<dyn Io> = if url.scheme() == "https" {
        let (config, name) = (tls?, server_name(url)?);
        Box::new(
            TlsConnector::from(config.clone())
                .connect(name, stream)
                .await
                .ok()?,
        )
    } else {
        Box::new(stream)
    };
    let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .ok()?;
    Some(Connected { sender, connection })
}

impl Connected {
    /// The request is handed to the connection before this returns, and is in flight from then.
    fn send(self, request: Request<Full<Bytes>>) -> impl Future<Output = Outcome> {
        let Self {
            mut sender,
            connection,
        } = self;
        let answer = sender.send_request(request);
        async move {
            let _sender = sender;
            let mut connection = std::pin::pin!(connection);
            let mut answer = std::pin::pin!(answer);
            // An answer still counts when its connection closes at the same time.
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
    headers: &[(&str, String)],
    body: String,
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
        .header(CONTENT_LENGTH, body.len());
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    builder.body(Full::new(Bytes::from(body)))
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// A lookup that holds its thread until `release` is sent.
    fn held(
        gate: &Arc<std::sync::Mutex<std::sync::mpsc::Receiver<()>>>,
        started: &tokio::sync::mpsc::UnboundedSender<()>,
    ) -> impl FnOnce() -> bool + Send + 'static {
        let (gate, started) = (gate.clone(), started.clone());
        move || {
            started.send(()).unwrap();
            gate.lock().unwrap().recv().is_ok()
        }
    }

    const SHORT: Duration = Duration::from_millis(100);

    #[tokio::test]
    async fn one_makers_stalled_lookups_leave_another_maker_its_slots() {
        let lane = Lane::new(4, Some(2), false);
        let (release, gate) = std::sync::mpsc::channel();
        let gate = Arc::new(std::sync::Mutex::new(gate));
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let lane = Arc::new(lane);
        let mut stalled = Vec::new();
        for _ in 0..2 {
            let (lane, gate, started) = (lane.clone(), gate.clone(), started.clone());
            stalled.push(tokio::spawn(async move {
                resolve_with(&lane, Some("a"), held(&gate, &started), SHORT).await
            }));
        }
        for _ in 0..2 {
            starts.recv().await.unwrap();
        }
        let third = resolve_with(&lane, Some("a"), || true, SHORT).await;
        assert!(
            matches!(third, Looked::NoSlot),
            "a maker at its share waits, then gets no slot"
        );
        let other = resolve_with(&lane, Some("b"), || true, SHORT).await;
        assert!(matches!(other, Looked::Done(true)));
        for job in stalled {
            assert!(matches!(job.await.unwrap(), Looked::Unfinished));
        }
        for _ in 0..2 {
            release.send(()).unwrap();
        }
    }

    #[tokio::test]
    async fn makers_together_cannot_pass_the_lanes_total() {
        let lane = Arc::new(Lane::new(2, Some(2), false));
        let (release, gate) = std::sync::mpsc::channel();
        let gate = Arc::new(std::sync::Mutex::new(gate));
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let mut stalled = Vec::new();
        for maker in ["a", "b"] {
            let (lane, gate, started) = (lane.clone(), gate.clone(), started.clone());
            stalled.push(tokio::spawn(async move {
                resolve_with(&lane, Some(maker), held(&gate, &started), SHORT).await
            }));
        }
        for _ in 0..2 {
            starts.recv().await.unwrap();
        }
        let third = resolve_with(&lane, Some("c"), || true, SHORT).await;
        assert!(matches!(third, Looked::NoSlot));
        for job in stalled {
            job.await.unwrap();
        }
        for _ in 0..2 {
            release.send(()).unwrap();
        }
    }

    #[tokio::test]
    async fn the_wait_for_a_slot_and_the_lookup_share_one_budget() {
        let lane = Arc::new(Lane::new(1, Some(1), false));
        let holder = {
            let lane = lane.clone();
            tokio::spawn(async move {
                resolve_with(
                    &lane,
                    Some("a"),
                    || std::thread::sleep(Duration::from_millis(200)),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = tokio::time::Instant::now();
        let waited_then_stalled = resolve_with(
            &lane,
            Some("a"),
            || std::thread::sleep(Duration::from_secs(1)),
            Duration::from_millis(300),
        )
        .await;
        assert!(matches!(waited_then_stalled, Looked::Unfinished));
        assert!(
            started.elapsed() < Duration::from_millis(450),
            "separate budgets would take about 500 ms"
        );
        holder.await.unwrap();
    }

    #[tokio::test]
    async fn a_patient_lane_waits_for_its_pool_and_gives_the_lookup_its_whole_bound_from_the_slot()
    {
        let lane = Arc::new(Lane::new(1, Some(4), true));
        let holder = {
            let lane = lane.clone();
            tokio::spawn(async move {
                resolve_with(
                    &lane,
                    Some("x"),
                    || std::thread::sleep(Duration::from_millis(700)),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let waited_then_looked = resolve_with(
            &lane,
            Some("y"),
            || std::thread::sleep(Duration::from_millis(50)),
            Duration::from_millis(400),
        )
        .await;
        assert!(
            matches!(waited_then_looked, Looked::Done(())),
            "the wait took longer than the bound and the lookup still had all of it"
        );
        holder.await.unwrap();
    }

    #[tokio::test]
    async fn a_patient_lane_gives_no_slot_only_when_the_makers_own_share_is_full() {
        let lane = Arc::new(Lane::new(8, Some(1), true));
        let (release, gate) = std::sync::mpsc::channel();
        let gate = Arc::new(std::sync::Mutex::new(gate));
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let stalled = {
            let (lane, gate, started) = (lane.clone(), gate.clone(), started.clone());
            tokio::spawn(async move {
                resolve_with(&lane, Some("a"), held(&gate, &started), SHORT).await
            })
        };
        starts.recv().await.unwrap();
        let second = resolve_with(&lane, Some("a"), || true, SHORT).await;
        assert!(matches!(second, Looked::NoSlot));
        let other = resolve_with(&lane, Some("b"), || true, SHORT).await;
        assert!(matches!(other, Looked::Done(true)));
        assert!(matches!(stalled.await.unwrap(), Looked::Unfinished));
        release.send(()).unwrap();
    }

    async fn free_again(lane: &Lane, total: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while lane.free() != total {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_slot_is_released_when_a_lookup_ends_in_any_way() {
        let lane = Arc::new(Lane::new(2, Some(2), false));
        let done = resolve_with(&lane, Some("a"), || Err::<(), _>("no such host"), SHORT).await;
        assert!(matches!(done, Looked::Done(Err(_))));
        free_again(&lane, 2).await;

        let panicked = resolve_with(&lane, Some("a"), || -> () { panic!("resolver") }, SHORT).await;
        assert!(matches!(panicked, Looked::Unfinished));
        free_again(&lane, 2).await;

        let timed_out = resolve_with(
            &lane,
            Some("a"),
            || std::thread::sleep(Duration::from_millis(300)),
            SHORT,
        )
        .await;
        assert!(matches!(timed_out, Looked::Unfinished));
        assert_eq!(
            lane.free(),
            1,
            "held while the thread is inside the resolver"
        );
        free_again(&lane, 2).await;

        let (release, gate) = std::sync::mpsc::channel();
        let gate = Arc::new(std::sync::Mutex::new(gate));
        let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
        let cancelled = {
            let (lane, gate, started) = (lane.clone(), gate.clone(), started.clone());
            tokio::spawn(async move {
                resolve_with(
                    &lane,
                    Some("a"),
                    held(&gate, &started),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        starts.recv().await.unwrap();
        cancelled.abort();
        let _ = cancelled.await;
        release.send(()).unwrap();
        free_again(&lane, 2).await;
    }

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

    async fn head<S: AsyncRead + Unpin>(stream: &mut S) -> String {
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

    const REFUSED: &str = "refused";

    async fn send_checked<F>(
        tls: Option<&Arc<ClientConfig>>,
        url: &Url,
        targets: &[Target],
        bound: Duration,
        check: F,
    ) -> Result<Outcome, &'static str>
    where
        F: Future<Output = Result<(), &'static str>>,
    {
        let headers = [("x-marfa-event-type", "item.created".to_string())];
        let outgoing = Outgoing {
            headers: &headers,
            body: "{}".to_string(),
        };
        post_with(tls, url, targets, outgoing, bound, || check).await
    }

    async fn send(url: &Url, targets: &[Target], bound: Duration) -> Outcome {
        send_checked(None, url, targets, bound, async { Ok(()) })
            .await
            .unwrap()
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
        let Reach::Targets(targets) = reach(&faults, &url, false, Asker::McpFetch).await else {
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
        assert_eq!(
            reach(&faults, &url, false, Asker::McpFetch).await,
            Reach::NotPublic
        );
    }

    #[tokio::test]
    async fn refuses_a_name_with_any_answer_that_is_not_public_unless_allowed() {
        let faults = Faults::default();
        faults
            .set("resolve:mixed.test", Some("93.184.216.34,10.0.0.1"))
            .unwrap();
        let url = Url::parse("https://mixed.test/").unwrap();
        assert_eq!(
            reach(&faults, &url, false, Asker::McpFetch).await,
            Reach::NotPublic
        );
        assert!(
            matches!(reach(&faults, &url, true, Asker::McpFetch).await, Reach::Targets(found) if found.len() == 2)
        );
        let literal = Url::parse("http://[::ffff:127.0.0.1]:9/").unwrap();
        assert_eq!(
            reach(&faults, &literal, false, Asker::McpFetch).await,
            Reach::NotPublic
        );
    }

    /// What reaches `stream` before it closes or goes quiet, and whether it closed.
    async fn bytes_until_closed<S: AsyncRead + Unpin>(stream: &mut S) -> (Vec<u8>, bool) {
        let mut seen = Vec::new();
        let mut chunk = [0u8; 256];
        loop {
            match tokio::time::timeout(Duration::from_millis(1_500), stream.read(&mut chunk)).await
            {
                Ok(Ok(0) | Err(_)) => return (seen, true),
                Ok(Ok(read)) => seen.extend_from_slice(&chunk[..read]),
                Err(_) => return (seen, false),
            }
        }
    }

    async fn waited(answer: Result<(), &'static str>) -> Result<(), &'static str> {
        tokio::time::sleep(Duration::from_millis(300)).await;
        answer
    }

    #[tokio::test]
    async fn a_check_that_refuses_once_connected_sends_nothing_and_closes_the_connection() {
        let (url, served) = receiver(|mut stream| async move {
            let (seen, closed) = bytes_until_closed(&mut stream).await;
            assert!(closed, "the connection was closed");
            String::from_utf8(seen).unwrap()
        })
        .await;
        let outcome = send_checked(
            None,
            &url,
            &loopback(),
            Duration::from_secs(5),
            waited(Err(REFUSED)),
        )
        .await;
        assert_eq!(outcome, Err(REFUSED));
        assert_eq!(served.await.unwrap(), "", "no header and no body arrived");
    }

    #[tokio::test]
    async fn a_check_that_passes_after_the_same_wait_sends_the_request() {
        let (url, served) = receiver(|mut stream| async move {
            let request = head(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await
                .unwrap();
            request
        })
        .await;
        let outcome = send_checked(
            None,
            &url,
            &loopback(),
            Duration::from_secs(5),
            waited(Ok(())),
        )
        .await;
        assert!(matches!(outcome, Ok(Outcome::Answered { status: 204, .. })));
        assert!(
            served
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("x-marfa-event-type: item.created")
        );
    }

    /// A receiver that answers `204` as soon as it accepts, then reads what arrives.
    async fn answering_before_reading() -> (Url, tokio::task::JoinHandle<String>) {
        receiver(|mut stream| async move {
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                .await
                .unwrap();
            let (seen, _) = bytes_until_closed(&mut stream).await;
            String::from_utf8(seen).unwrap()
        })
        .await
    }

    #[tokio::test]
    async fn an_answer_sent_before_the_request_counts_for_nothing_when_the_check_refuses() {
        let (url, served) = answering_before_reading().await;
        let outcome = send_checked(
            None,
            &url,
            &loopback(),
            Duration::from_secs(5),
            waited(Err(REFUSED)),
        )
        .await;
        assert_eq!(outcome, Err(REFUSED));
        assert_eq!(served.await.unwrap(), "");
    }

    #[tokio::test]
    async fn an_answer_that_arrives_before_the_request_is_written_is_not_taken() {
        let (url, served) = answering_before_reading().await;
        let outcome = send_checked(
            None,
            &url,
            &loopback(),
            Duration::from_secs(5),
            waited(Ok(())),
        )
        .await;
        assert_eq!(outcome, Ok(Outcome::Unreachable));
        assert_eq!(served.await.unwrap(), "");
    }

    #[tokio::test]
    async fn a_receiver_that_is_never_reached_is_never_checked() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(
            send_checked(None, &url, &loopback(), Duration::from_secs(5), async {
                Err(REFUSED)
            })
            .await,
            Ok(Outcome::Unreachable)
        );
    }

    #[tokio::test]
    async fn a_check_that_runs_past_the_bound_ends_the_attempt_as_timed_out_and_sends_nothing() {
        let (url, served) = receiver(|mut stream| async move {
            let (seen, closed) = bytes_until_closed(&mut stream).await;
            assert!(closed, "the connection was closed");
            String::from_utf8(seen).unwrap()
        })
        .await;
        let began = Instant::now();
        let outcome = send_checked(None, &url, &loopback(), Duration::from_millis(300), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(())
        })
        .await;
        assert_eq!(outcome, Ok(Outcome::TimedOut));
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "the check was cut at the bound"
        );
        assert_eq!(served.await.unwrap(), "", "no header and no body arrived");
    }

    #[tokio::test]
    async fn the_check_and_the_answer_share_one_bound() {
        let (url, _served) = receiver(|mut stream| async move {
            head(&mut stream).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
            String::new()
        })
        .await;
        let began = Instant::now();
        let check = async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(())
        };
        let outcome =
            send_checked(None, &url, &loopback(), Duration::from_millis(1_500), check).await;
        assert_eq!(outcome, Ok(Outcome::TimedOut));
        assert!(
            began.elapsed() < Duration::from_millis(2_000),
            "the answer had only what the check left of the bound"
        );
    }

    /// An HTTPS receiver with a certificate only the returned client trusts. It reports whether
    /// its handshake finished, then what it read before the connection closed.
    async fn secured_receiver(
        answer: bool,
    ) -> (
        Url,
        Arc<ClientConfig>,
        tokio::sync::oneshot::Receiver<()>,
        tokio::task::JoinHandle<String>,
    ) {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer};

        let certified = rcgen::generate_simple_self_signed(vec!["hook.test".to_string()]).unwrap();
        let certificate = CertificateDer::from(certified.cert.der().to_vec());
        let key = PrivateKeyDer::try_from(certified.signing_key.serialize_der()).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate.clone()], key)
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate).unwrap();
        let client = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (secured, handshaken) = tokio::sync::oneshot::channel();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server));
        let served = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = acceptor.accept(stream).await.unwrap();
            secured.send(()).unwrap();
            if answer {
                let request = head(&mut stream).await;
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\n\r\n")
                    .await
                    .unwrap();
                stream.flush().await.unwrap();
                return request;
            }
            let (seen, closed) = bytes_until_closed(&mut stream).await;
            assert!(closed, "the connection was closed");
            String::from_utf8(seen).unwrap()
        });
        (
            Url::parse(&format!("https://hook.test:{port}/hook")).unwrap(),
            Arc::new(client),
            handshaken,
            served,
        )
    }

    #[tokio::test]
    async fn over_https_the_check_comes_after_the_handshake_and_a_refusal_sends_nothing() {
        let (url, client, handshaken, served) = secured_receiver(false).await;
        let check = async {
            tokio::time::timeout(Duration::from_secs(5), handshaken)
                .await
                .expect("the handshake finished before the check decided")
                .unwrap();
            Err(REFUSED)
        };
        let outcome = send_checked(
            Some(&client),
            &url,
            &loopback(),
            Duration::from_secs(5),
            check,
        )
        .await;
        assert_eq!(outcome, Err(REFUSED));
        assert_eq!(
            served.await.unwrap(),
            "",
            "nothing arrived over the secured connection"
        );
    }

    #[tokio::test]
    async fn over_https_a_check_that_passes_after_the_handshake_sends_the_request() {
        let (url, client, handshaken, served) = secured_receiver(true).await;
        let check = async {
            tokio::time::timeout(Duration::from_secs(5), handshaken)
                .await
                .expect("the handshake finished before the check decided")
                .unwrap();
            Ok(())
        };
        let outcome = send_checked(
            Some(&client),
            &url,
            &loopback(),
            Duration::from_secs(5),
            check,
        )
        .await;
        assert!(
            matches!(outcome, Ok(Outcome::Answered { status: 204, .. })),
            "{outcome:?}"
        );
        assert!(
            served
                .await
                .unwrap()
                .to_ascii_lowercase()
                .contains("host: hook.test:")
        );
    }
}
