//! Where connections come from. [`serve`] takes any source of streams through
//! axum's `Listener`, so nothing above it owns a socket: a source plugs in by
//! implementing that trait and [`Source`].

use std::fmt::Debug;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Router;
use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream, unix};

/// Long enough for a server out of file descriptors not to spin, and short
/// enough to serve again soon after one frees.
const ACCEPT_PAUSE: Duration = Duration::from_millis(250);

/// The network address at the far end of a connection, reaching each request
/// as connect info. A private socket has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peer(pub Option<IpAddr>);

/// A listener that can say who is at the far end of what it accepts.
pub trait Source: Listener<Addr: Debug> {
    fn peer(address: &Self::Addr) -> Peer;
}

impl<L: Source> Connected<IncomingStream<'_, L>> for Peer {
    fn connect_info(stream: IncomingStream<'_, L>) -> Peer {
        L::peer(stream.remote_addr())
    }
}

/// Serves `router` on `listener` until `stop`, then lets open requests finish.
pub async fn serve(
    listener: impl Source,
    router: Router,
    stop: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let service = router.into_make_service_with_connect_info::<Peer>();
    axum::serve(listener, service)
        .with_graceful_shutdown(stop)
        .await
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
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::timeout;

    use super::super::finished;
    use super::super::observe::RequestContext;
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
        finished(Router::new().route("/who", get(who)), app, declared)
    }

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
}
