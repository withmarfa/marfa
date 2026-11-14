//! Every outbound request goes through here, to public addresses judged once.

pub mod address;
mod fair;
mod slots;

pub use slots::{Asker, deliveries_released, delivery_share_is_free};
use slots::{BOUND, Lane};

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
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

/// The bound includes connecting; redirects are never followed.
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
                    || std::thread::sleep(Duration::from_millis(300)),
                    Duration::from_secs(5),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let waited_then_looked = resolve_with(
            &lane,
            Some("y"),
            || std::thread::sleep(Duration::from_millis(200)),
            Duration::from_millis(250),
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
}
