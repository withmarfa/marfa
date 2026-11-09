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
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream, unix};
use tokio::sync::{Notify, Semaphore, watch};
use tokio::task::JoinSet;
use tower::ServiceExt;

use super::connections::{self, Caps, Gate};

/// Long enough for a server out of file descriptors not to spin.
const ACCEPT_PAUSE: Duration = Duration::from_millis(250);

/// From the moment the server waits for a request head; a connection waiting for its next
/// request is held to the same time.
pub const PUBLIC_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONTROL_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peer(pub Option<IpAddr>);

pub trait Source: Listener<Addr: Debug> {
    fn peer(address: &Self::Addr) -> Peer;
}

/// How many turned-away connections are being answered at once. Past it a connection is closed
/// unanswered, so a flood cannot hold file descriptors by being refused.
const MOST_REFUSALS_AT_ONCE: usize = 64;
const TURN_AWAY_BUDGET: Duration = Duration::from_secs(1);

fn turn_away<Io: AsyncWrite + Unpin + Send + 'static>(
    mut stream: Io,
    answer: Arc<[u8]>,
    room: &Arc<Semaphore>,
) {
    let Ok(place) = room.clone().try_acquire_owned() else {
        return;
    };
    tokio::spawn(async move {
        let _place = place;
        let _ = tokio::time::timeout(TURN_AWAY_BUDGET, async {
            stream.write_all(&answer).await?;
            stream.shutdown().await
        })
        .await;
    });
}

/// Ending a response body cannot close a connection blocked on queued output.
#[derive(Clone)]
pub struct Hangup {
    close: Arc<Notify>,
    /// Its sender lives as long as the connection.
    open: watch::Receiver<()>,
}

impl Hangup {
    pub fn now(&self) {
        self.close.notify_one();
    }

    pub async fn closed(mut self) {
        while self.open.changed().await.is_ok() {}
    }
}

/// A stop closes every connection with no request in flight, a partial head included, and
/// waits only for the requests that are.
pub async fn serve<L: Source>(
    mut listener: L,
    router: Router,
    stop: impl Future<Output = ()> + Send + 'static,
    header_read_timeout: Duration,
    caps: Option<Caps>,
) -> io::Result<()> {
    let gate = caps.map(Gate::new);
    let turned_away: Arc<[u8]> = connections::turned_away().into();
    let refusals = Arc::new(Semaphore::new(MOST_REFUSALS_AT_ONCE));
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
        let slot = match gate.as_ref().map(|gate| gate.enter(peer)) {
            Some(Err(turned)) => {
                tracing::debug!(?turned, "A connection was turned away");
                turn_away(stream, turned_away.clone(), &refusals);
                continue;
            }
            Some(Ok(slot)) => Some(slot),
            None => None,
        };
        let router = router.clone();
        let asked = Arc::new(AtomicBool::new(false));
        let (open, watching) = watch::channel(());
        let hangup = Hangup {
            close: Arc::new(Notify::new()),
            open: watching,
        };
        let service = service_fn({
            let (asked, hangup) = (asked.clone(), hangup.clone());
            move |mut request: hyper::Request<Incoming>| {
                asked.store(true, Ordering::Release);
                request.extensions_mut().insert(ConnectInfo(peer));
                request.extensions_mut().insert(hangup.clone());
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
            let _open = open;
            let _slot = slot;
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
                    () = hangup.close.notified() => break,
                    _ = stopped.wait_for(|stopping| *stopping), if !told => {
                        // Hyper holds a connection with a partly read first head until the header timeout.
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
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
    use tokio::sync::{Notify, mpsc, oneshot};
    use tokio::time::timeout;

    use super::super::doors::{Doors, get};
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
        router_of(dir, trust, Doors::new().route("/who", get(who))).await
    }

    async fn router_of(dir: &TempDir, trust: &str, routes: Routes) -> Router {
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let settings = Settings::read(Environment::from_pairs(&[
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
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
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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

    async fn turned_away(mut stream: impl AsyncReadExt + Unpin) -> String {
        let mut answer = String::new();
        timeout(Duration::from_secs(5), stream.read_to_string(&mut answer))
            .await
            .expect("a refused connection was never answered and closed")
            .unwrap();
        answer
    }

    async fn served_within(
        mut connect: impl FnMut() -> Option<DuplexStream>,
        ask: &str,
    ) -> Option<String> {
        for _ in 0..100 {
            if let Some(mut near) = connect() {
                near.write_all(ask.as_bytes()).await.unwrap();
                let mut answer = String::new();
                near.read_to_string(&mut answer).await.unwrap();
                if answer.starts_with("HTTP/1.1 200") {
                    return Some(answer);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }

    #[tokio::test]
    async fn a_listener_at_its_total_turns_a_connection_away_and_serves_again_once_one_ends() {
        let dir = TempDir::new().unwrap();
        let (connect, incoming) = mpsc::unbounded_channel();
        let caps = Caps {
            total: 2,
            per_address: 2,
            trust: Trust::Nothing,
        };
        let server = tokio::spawn(serve(
            Memory(incoming),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
            PUBLIC_HEADER_READ_TIMEOUT,
            Some(caps),
        ));
        let open = |peer: &str| {
            let (near, far) = duplex(4096);
            connect
                .send((far, Peer(Some(peer.parse().unwrap()))))
                .unwrap();
            near
        };
        let first = open("192.0.2.1");
        let _second = open("192.0.2.2");
        let answer = turned_away(open("192.0.2.3")).await;
        assert!(answer.starts_with("HTTP/1.1 503 "), "{answer}");
        assert!(answer.contains("Retry-After: 5"), "{answer}");
        assert!(answer.contains("too_many_connections"), "{answer}");

        drop(first);
        let served = served_within(|| Some(open("192.0.2.3")), &asking("203.0.113.9", false)).await;
        assert!(
            served.is_some(),
            "no place was freed by the closed connection"
        );
        server.abort();
    }

    #[tokio::test]
    async fn an_address_at_its_share_is_turned_away_and_another_address_is_served() {
        let dir = TempDir::new().unwrap();
        let (connect, incoming) = mpsc::unbounded_channel();
        let caps = Caps {
            total: 10,
            per_address: 1,
            trust: Trust::Nothing,
        };
        let server = tokio::spawn(serve(
            Memory(incoming),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
            PUBLIC_HEADER_READ_TIMEOUT,
            Some(caps),
        ));
        let open = |peer: &str| {
            let (near, far) = duplex(4096);
            connect
                .send((far, Peer(Some(peer.parse().unwrap()))))
                .unwrap();
            near
        };
        let held = open("192.0.2.1");
        let answer = turned_away(open("192.0.2.1")).await;
        assert!(answer.starts_with("HTTP/1.1 503 "), "{answer}");
        let other = answer_of(open("192.0.2.2"), &asking("203.0.113.9", false)).await;
        assert_eq!(other, "Some(192.0.2.2)");

        drop(held);
        let served = served_within(|| Some(open("192.0.2.1")), &asking("203.0.113.9", false)).await;
        assert!(
            served.is_some(),
            "no place was freed by the closed connection"
        );
        server.abort();
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
        let server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
            Duration::from_millis(200),
            None,
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
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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
        let routes = Doors::new().route("/slow", get(slow).layer(Extension(gate.clone())));
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, stopping) = oneshot::channel::<()>();
        let mut server = tokio::spawn(serve(
            Tcp::new(listener, "test"),
            router_of(&dir, "10.0.0.0/8", routes).await,
            async move {
                let _ = stopping.await;
            },
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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

    struct Watched {
        inner: TcpStream,
        closed: mpsc::UnboundedSender<()>,
    }

    impl Drop for Watched {
        fn drop(&mut self) {
            let _ = self.closed.send(());
        }
    }

    impl tokio::io::AsyncRead for Watched {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl tokio::io::AsyncWrite for Watched {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    struct Watching {
        tcp: Tcp,
        closed: mpsc::UnboundedSender<()>,
    }

    impl Listener for Watching {
        type Io = Watched;
        type Addr = SocketAddr;

        async fn accept(&mut self) -> (Watched, SocketAddr) {
            let (inner, address) = self.tcp.accept().await;
            (
                Watched {
                    inner,
                    closed: self.closed.clone(),
                },
                address,
            )
        }

        fn local_addr(&self) -> io::Result<SocketAddr> {
            self.tcp.local_addr()
        }
    }

    impl Source for Watching {
        fn peer(address: &SocketAddr) -> Peer {
            Tcp::peer(address)
        }
    }

    struct Script(std::collections::VecDeque<std::result::Result<axum::body::Bytes, io::Error>>);

    impl http_body::Body for Script {
        type Data = axum::body::Bytes;
        type Error = io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<std::result::Result<http_body::Frame<Self::Data>, io::Error>>>
        {
            std::task::Poll::Ready(
                self.0
                    .pop_front()
                    .map(|next| next.map(http_body::Frame::data)),
            )
        }
    }

    /// More than the socket buffers and hyper's queue hold, so the connection is blocked writing it.
    fn unread_body() -> Body {
        let big = axum::body::Bytes::from(vec![b'x'; 8 << 20]);
        Body::new(Script([Ok(big)].into()))
    }

    async fn hangs_up_later(Extension(hangup): Extension<Hangup>) -> axum::response::Response {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            hangup.now();
        });
        axum::response::Response::new(unread_body())
    }

    async fn serve_watched(
        dir: &TempDir,
        routes: Routes,
        stop: oneshot::Receiver<()>,
    ) -> (
        u16,
        tokio::task::JoinHandle<io::Result<()>>,
        mpsc::UnboundedReceiver<()>,
    ) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (closed, dropped) = mpsc::unbounded_channel();
        let server = tokio::spawn(serve(
            Watching {
                tcp: Tcp::new(listener, "test"),
                closed,
            },
            router_of(dir, "10.0.0.0/8", routes).await,
            async move {
                let _ = stop.await;
            },
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
        ));
        (port, server, dropped)
    }

    async fn stalled_get(port: u16, path: &str) -> TcpStream {
        let mut peer = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        peer.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .await
            .unwrap();
        peer
    }

    #[tokio::test]
    async fn a_handler_can_close_the_connection_of_a_peer_that_takes_nothing() {
        let dir = TempDir::new().unwrap();
        let routes = Doors::new().route("/stream", get(hangs_up_later));
        let (_stop, stopping) = oneshot::channel();
        let (port, server, mut dropped) = serve_watched(&dir, routes, stopping).await;
        let _peer = stalled_get(port, "/stream").await;

        assert!(
            timeout(Duration::from_millis(100), dropped.recv())
                .await
                .is_err(),
            "the connection was closed before the handler asked"
        );
        timeout(Duration::from_secs(3), dropped.recv())
            .await
            .expect("the connection of a peer that reads nothing stayed open");
        server.abort();
    }

    #[tokio::test]
    async fn one_connection_serves_two_requests() {
        let dir = TempDir::new().unwrap();
        let (connect, incoming) = mpsc::unbounded_channel();
        let server = tokio::spawn(serve(
            Memory(incoming),
            router(&dir, "10.0.0.0/8").await,
            std::future::pending(),
            PUBLIC_HEADER_READ_TIMEOUT,
            None,
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
