//! [`serve`] takes any source of streams through axum's `Listener`; a source plugs in by
//! implementing that trait and [`Source`].

use std::fmt::Debug;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::serve::Listener;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream, unix};
use tokio::sync::watch;
use tokio::task::JoinSet;
use tower::ServiceExt;

/// Long enough for a server out of file descriptors not to spin.
const ACCEPT_PAUSE: Duration = Duration::from_millis(250);

/// From the moment the server waits for a request head; a connection waiting for its next
/// request is held to the same time.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peer(pub Option<IpAddr>);

pub trait Source: Listener<Addr: Debug> {
    fn peer(address: &Self::Addr) -> Peer;
}

/// A stop closes every connection with no request in flight, a partial head included, and
/// waits only for the requests that are.
pub async fn serve(
    listener: impl Source,
    router: Router,
    stop: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    serve_within(listener, router, stop, HEADER_READ_TIMEOUT).await
}

async fn serve_within<L: Source>(
    mut listener: L,
    router: Router,
    stop: impl Future<Output = ()> + Send + 'static,
    header_read_timeout: Duration,
) -> io::Result<()> {
    let (stopping, _) = watch::channel(false);
    let mut connections = JoinSet::new();
    let mut stop = pin!(stop);
    loop {
        let (stream, address) = tokio::select! {
            accepted = listener.accept() => accepted,
            Some(_) = connections.join_next() => continue,
            () = &mut stop => break,
        };
        let peer = L::peer(&address);
        let router = router.clone();
        let asked = Arc::new(AtomicBool::new(false));
        let service = service_fn({
            let asked = asked.clone();
            move |mut request: hyper::Request<Incoming>| {
                asked.store(true, Ordering::Release);
                request.extensions_mut().insert(ConnectInfo(peer));
                router.clone().oneshot(request.map(Body::new))
            }
        });
        let connection = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(header_read_timeout)
            .keep_alive(true)
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades();
        let mut stopped = stopping.subscribe();
        connections.spawn(async move {
            let mut connection = pin!(connection);
            let mut told = false;
            loop {
                tokio::select! {
                    result = connection.as_mut() => {
                        if let Err(error) = result {
                            tracing::debug!(error = %error, "A connection ended with an error");
                        }
                        break;
                    }
                    _ = stopped.wait_for(|stopping| *stopping), if !told => {
                        // Hyper closes an idle connection at once, but keeps one
                        // whose first head is only partly read until the header
                        // timeout, though no request has begun on it.
                        if !asked.load(Ordering::Acquire) {
                            break;
                        }
                        connection.as_mut().graceful_shutdown();
                        told = true;
                    }
                }
            }
        });
    }
    drop(listener);
    stopping.send_replace(true);
    while connections.join_next().await.is_some() {}
    Ok(())
}

fn closed_by_its_caller(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
    )
}

/// The next connection, however many accepts fail first: `Listener::accept`
/// has no way to give up, and a failed accept must not end the server.
async fn next_connection<T, F: Future<Output = io::Result<T>>>(
    listener: &str,
    mut accept: impl FnMut() -> F,
) -> T {
    loop {
        match accept().await {
            Ok(connection) => return connection,
            Err(error) if closed_by_its_caller(&error) => {}
            Err(error) => {
                tracing::error!(listener, error = %error, "A connection could not be accepted");
                tokio::time::sleep(ACCEPT_PAUSE).await;
            }
        }
    }
}

pub struct Tcp {
    listener: TcpListener,
    name: &'static str,
}

impl Tcp {
    pub fn new(listener: TcpListener, name: &'static str) -> Tcp {
        Tcp { listener, name }
    }
}

impl Listener for Tcp {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        next_connection(self.name, || self.listener.accept()).await
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

impl Source for Tcp {
    fn peer(address: &SocketAddr) -> Peer {
        Peer(Some(address.ip()))
    }
}

pub struct Socket {
    listener: UnixListener,
    name: &'static str,
}

impl Socket {
    pub fn new(listener: UnixListener, name: &'static str) -> Socket {
        Socket { listener, name }
    }
}

impl Listener for Socket {
    type Io = UnixStream;
    type Addr = unix::SocketAddr;

    async fn accept(&mut self) -> (UnixStream, unix::SocketAddr) {
        next_connection(self.name, || self.listener.accept()).await
    }

    fn local_addr(&self) -> io::Result<unix::SocketAddr> {
        self.listener.local_addr()
    }
}

impl Source for Socket {
    fn peer(_: &unix::SocketAddr) -> Peer {
        Peer(None)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use axum::Extension;
    use axum::routing::get;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
    use tokio::sync::{Notify, mpsc, oneshot};
    use tokio::time::timeout;

    use super::super::observe::RequestContext;
    use super::super::{Routes, finished};
    use super::*;
    use crate::app::App;
    use crate::listener::{Declaration, Transport, Trust, proxy_ranges};
    use crate::settings::{Environment, Settings};

    struct Memory(mpsc::UnboundedReceiver<(DuplexStream, Peer)>);

    impl Listener for Memory {
        type Io = DuplexStream;
        type Addr = Peer;

        async fn accept(&mut self) -> (DuplexStream, Peer) {
            match self.0.recv().await {
                Some(connection) => connection,
                None => std::future::pending().await,
            }
        }

        fn local_addr(&self) -> io::Result<Peer> {
            Ok(Peer(None))
        }
    }

    impl Source for Memory {
        fn peer(address: &Peer) -> Peer {
            *address
        }
    }

    async fn who(Extension(context): Extension<RequestContext>) -> String {
        format!("{:?}", context.caller_address)
    }

    async fn router(dir: &TempDir, trust: &str) -> Router {
        router_of(dir, trust, Router::new().route("/who", get(who))).await
    }

    async fn router_of(dir: &TempDir, trust: &str, routes: Routes) -> Router {
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let settings = Settings::read(Environment::from_pairs(&[
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
        ]))
        .unwrap();
        let app: Arc<App> = App::start(settings).await.unwrap();
        let declared = Declaration {
            name: "test",
            transport: Transport::Http,
            trust: Trust::Proxies(proxy_ranges(trust).unwrap()),
        };
        finished(routes, app, declared)
    }

    #[derive(Clone)]
    struct Gate {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn slow(Extension(gate): Extension<Gate>) -> &'static str {
        gate.entered.notify_one();
        gate.release.notified().await;
        "late"
    }

    async fn read_response(stream: &mut (impl AsyncReadExt + Unpin)) -> String {
        let mut bytes = Vec::new();
        let mut byte = [0];
        while !bytes.ends_with(b"\r\n\r\n") {
            assert_eq!(stream.read(&mut byte).await.unwrap(), 1, "closed early");
            bytes.push(byte[0]);
        }
        let head = String::from_utf8(bytes).unwrap();
        let length = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")?
                    .parse()
                    .ok()
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        head + &String::from_utf8(body).unwrap()
    }

    const PARTIAL_HEAD: &[u8] = b"GET /who HTTP/1.1\r\nHost: any";

    fn asking(forwarded: &str, keep_alive: bool) -> String {
        let connection = if keep_alive { "keep-alive" } else { "close" };
        format!(
            "GET /who HTTP/1.1\r\nHost: anywhere\r\nConnection: {connection}\r\n\
             X-Forwarded-For: {forwarded}\r\n\r\n"
        )
    }

    async fn answer_of(mut stream: impl AsyncReadExt + AsyncWriteExt + Unpin, ask: &str) -> String {
        stream.write_all(ask.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        answer.split("\r\n\r\n").nth(1).unwrap().to_string()
    }

    #[tokio::test]
    async fn any_source_of_streams_is_served_and_its_peer_reaches_the_request() {
        let dir = TempDir::new().unwrap();
        let (connect, incoming) = mpsc::unbounded_channel();
        let server = tokio::spawn(serve(
            Memory(incoming),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
        ));
        for (peer, answer) in [
            (Some("10.0.0.1"), "Some(203.0.113.9)"),
            (Some("::ffff:10.0.0.1"), "Some(203.0.113.9)"),
            (Some("192.0.2.1"), "Some(192.0.2.1)"),
            (None, "None"),
        ] {
            let (near, far) = duplex(4096);
            let peer = Peer(peer.map(|peer| peer.parse().unwrap()));
            connect.send((far, peer)).unwrap();
            let asked = answer_of(near, &asking("203.0.113.9", false)).await;
            assert_eq!(asked, answer);
        }
        server.abort();
    }

    #[tokio::test]
    async fn a_caller_on_ipv4_through_an_ipv6_socket_is_matched_as_ipv4() {
        let dir = TempDir::new().unwrap();
        let Ok(listener) = TcpListener::bind(("::", 0)).await else {
            return;
        };
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router(&dir, "127.0.0.1/32").await,
            std::future::pending(),
        ));
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let asked = answer_of(stream, &asking("203.0.113.9", false)).await;
        assert_eq!(asked, "Some(203.0.113.9)");
        server.abort();
    }

    #[tokio::test]
    async fn a_stop_does_not_wait_for_connections_with_nothing_in_flight() {
        let dir = TempDir::new().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopping) = oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router(&dir, "10.0.0.0/8").await,
            async move {
                let _ = stopping.await;
            },
        ));

        let mut kept = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        kept.write_all(asking("203.0.113.9", true).as_bytes())
            .await
            .unwrap();
        let mut first = [0; 512];
        assert!(kept.read(&mut first).await.unwrap() > 0);
        let mut silent = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        stop.send(()).unwrap();
        timeout(Duration::from_secs(2), server)
            .await
            .expect("the stop waited on an idle connection")
            .unwrap()
            .unwrap();
        assert_eq!(kept.read(&mut first).await.unwrap(), 0);
        assert_eq!(silent.read(&mut first).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_failed_accept_pauses_and_tries_again() {
        let started = Instant::now();
        let mut failures = [io::Error::from_raw_os_error(libc::EMFILE)].into_iter();
        let connection = next_connection("test", || {
            let next = failures.next();
            async move { next.map_or(Ok("accepted"), Err) }
        })
        .await;
        assert_eq!(connection, "accepted");
        assert!(started.elapsed() >= ACCEPT_PAUSE);
    }

    #[tokio::test]
    async fn a_connection_closed_by_its_caller_is_no_fault_and_no_pause() {
        let started = Instant::now();
        let mut failures = [io::Error::from(io::ErrorKind::ConnectionAborted)].into_iter();
        next_connection("test", || {
            let next = failures.next();
            async move { next.map_or(Ok(()), Err) }
        })
        .await;
        assert!(started.elapsed() < ACCEPT_PAUSE);
    }

    #[tokio::test]
    async fn a_connection_with_a_partial_head_is_closed_after_the_header_timeout() {
        let dir = TempDir::new().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_within(
            Tcp::new(listener, "test"),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
            Duration::from_millis(200),
        ));
        let mut stalled = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stalled.write_all(PARTIAL_HEAD).await.unwrap();

        let started = Instant::now();
        let mut answer = Vec::new();
        timeout(Duration::from_secs(5), stalled.read_to_end(&mut answer))
            .await
            .expect("the stalled connection was never closed")
            .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(!String::from_utf8_lossy(&answer).contains(" 200 "));
        server.abort();
    }

    #[tokio::test]
    async fn a_stop_closes_a_partial_head_at_once_on_a_new_or_a_reused_connection() {
        let dir = TempDir::new().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopping) = oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router(&dir, "10.0.0.0/8").await,
            async move {
                let _ = stopping.await;
            },
        ));
        let mut stalled = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stalled.write_all(PARTIAL_HEAD).await.unwrap();
        let mut reused = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        reused
            .write_all(asking("203.0.113.9", true).as_bytes())
            .await
            .unwrap();
        read_response(&mut reused).await;
        reused.write_all(PARTIAL_HEAD).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let started = Instant::now();
        stop.send(()).unwrap();
        timeout(Duration::from_secs(2), server)
            .await
            .expect("the stop waited on a partial head")
            .unwrap()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(stalled.read(&mut [0; 16]).await.unwrap(), 0);
        assert_eq!(reused.read(&mut [0; 16]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_stop_waits_for_a_request_in_flight_and_answers_it_before_closing() {
        let dir = TempDir::new().unwrap();
        let gate = Gate {
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let routes = Router::new()
            .route("/slow", get(slow))
            .layer(Extension(gate.clone()));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopping) = oneshot::channel::<()>();
        let mut server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router_of(&dir, "10.0.0.0/8", routes).await,
            async move {
                let _ = stopping.await;
            },
        ));
        let mut open = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        open.write_all(b"GET /slow HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        gate.entered.notified().await;

        stop.send(()).unwrap();
        assert!(
            timeout(Duration::from_millis(300), &mut server)
                .await
                .is_err(),
            "the stop did not wait for the request"
        );
        gate.release.notify_one();
        let answer = read_response(&mut open).await;
        assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
        assert!(answer.ends_with("late"), "{answer}");
        assert!(answer.to_ascii_lowercase().contains("connection: close"));
        timeout(Duration::from_secs(2), server)
            .await
            .expect("the stop did not end once the request had")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn one_connection_serves_two_requests() {
        let dir = TempDir::new().unwrap();
        let (connect, incoming) = mpsc::unbounded_channel();
        let server = tokio::spawn(serve(
            Memory(incoming),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
        ));
        let (mut near, far) = duplex(4096);
        connect.send((far, Peer(None))).unwrap();
        for _ in 0..2 {
            near.write_all(asking("203.0.113.9", true).as_bytes())
                .await
                .unwrap();
            let answer = read_response(&mut near).await;
            assert!(answer.starts_with("HTTP/1.1 200"), "{answer}");
            assert!(answer.ends_with("None"), "{answer}");
        }
        server.abort();
    }
}
