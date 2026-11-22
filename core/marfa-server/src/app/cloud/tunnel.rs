//! The listener on 127.0.0.1 that only the tunnel connector is given, open while a link is
//! linking or linked.

use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::app::App;

/// How long a closed listener's requests in flight have before they are cut.
const GRACE: Duration = Duration::from_secs(2);

pub type Stop = Pin<Box<dyn Future<Output = ()> + Send>>;
pub type Serving = Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;
/// Serves the app on a listener until the stop ends.
pub type Serve = Box<dyn Fn(TcpListener, Stop) -> Serving + Send + Sync>;

struct Open {
    port: u16,
    close: watch::Sender<bool>,
    task: JoinHandle<io::Result<()>>,
}

#[derive(Default)]
pub struct Tunnel {
    serve: OnceLock<Serve>,
    open: Mutex<Option<Open>>,
}

/// A listener on 127.0.0.1 at `port`, where 0 asks for a free one.
pub fn bind(port: u16) -> io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
    socket.listen(1024)
}

impl Tunnel {
    /// Gives the listener what serves it; a server with no public listener gives nothing.
    pub fn install(&self, serve: Serve) {
        let _ = self.serve.set(serve);
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Option<Open>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn port(&self) -> Option<u16> {
        self.held()
            .as_ref()
            .filter(|open| !open.task.is_finished())
            .map(|open| open.port)
    }

    /// Opens the listener at `port`, taking `fresh` where it is bound there, and says whether it is open.
    pub fn open(&self, app: &App, port: u16, fresh: Option<TcpListener>) -> bool {
        let Some(serve) = self.serve.get() else {
            return false;
        };
        let mut held = self.held();
        if let Some(open) = held.as_ref()
            && open.port == port
            && !open.task.is_finished()
        {
            return true;
        }
        if *app.stopping().borrow() {
            return false;
        }
        if let Some(open) = held.take() {
            close(open);
        }
        let fresh = fresh.filter(|listener| {
            listener
                .local_addr()
                .is_ok_and(|address| address.port() == port)
        });
        let listener = match fresh.map_or_else(|| bind(port), Ok) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::debug!(port, error = %error, "The tunnel listener could not be bound");
                return false;
            }
        };
        let (closing, closed) = watch::channel(false);
        let stop: Stop = Box::pin(stopped(app.stopping(), closed));
        let task = tokio::spawn(serve(listener, stop));
        *held = Some(Open {
            port,
            close: closing,
            task,
        });
        true
    }

    pub fn close(&self) {
        if let Some(open) = self.held().take() {
            close(open);
        }
    }

    /// Waits for the listener to end once the server stops.
    pub async fn settle(&self) {
        let task = self.held().take().map(|open| open.task);
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

async fn stopped(mut stopping: watch::Receiver<bool>, mut closed: watch::Receiver<bool>) {
    tokio::select! {
        _ = stopping.wait_for(|stopping| *stopping) => {}
        _ = closed.wait_for(|closed| *closed) => {}
    }
}

fn close(open: Open) {
    open.close.send_replace(true);
    let mut task = open.task;
    tokio::spawn(async move {
        if tokio::time::timeout(GRACE, &mut task).await.is_err() {
            task.abort();
        }
    });
}

/// Serves the tunnel listener with `serve`, for as long as the app lives.
pub fn install(
    app: &Arc<App>,
    serve: impl Fn(Arc<App>, TcpListener, Stop) -> Serving + Send + Sync + 'static,
) {
    let weak = Arc::downgrade(app);
    app.cloud
        .tunnel
        .install(Box::new(move |listener, stop| match weak.upgrade() {
            Some(app) => serve(app, listener, stop),
            None => Box::pin(async { Ok(()) }),
        }));
}
