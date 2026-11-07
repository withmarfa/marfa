//! A server's life, from settings to exit.

use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, UnixListener};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::watch;
use tokio::task::JoinSet;

use crate::app::App;
use crate::control_socket::Claim;
use crate::failure::Failure;
use crate::http;
use crate::settings::Accepted;

/// Leaves room inside the ten seconds a container runtime gives a stop.
const STOP_WAIT: Duration = Duration::from_secs(7);

async fn bind_public(app: &App) -> Result<TcpListener, Failure> {
    let start = &app.settings.start;
    let refused = |error: std::io::Error| {
        Failure::start(format!(
            "The port {} could not be bound: {error}",
            start.port
        ))
    };
    match &start.listen_host {
        Some(host) => TcpListener::bind((host.as_str(), start.port))
            .await
            .map_err(refused),
        None => match TcpListener::bind(("::", start.port)).await {
            Ok(listener) => Ok(listener),
            Err(_) => TcpListener::bind(("0.0.0.0", start.port))
                .await
                .map_err(refused),
        },
    }
}

struct Signals {
    terminate: Signal,
    interrupt: Signal,
}

impl Signals {
    fn install() -> Result<Signals, Failure> {
        let refused =
            |error| Failure::start(format!("The stop signals could not be taken: {error}"));
        Ok(Signals {
            terminate: signal(SignalKind::terminate()).map_err(refused)?,
            interrupt: signal(SignalKind::interrupt()).map_err(refused)?,
        })
    }

    async fn next(&mut self) {
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = self.interrupt.recv() => {}
        }
    }
}

async fn stopped(mut stop: watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopping| *stopping).await;
}

fn listen(
    servers: &mut JoinSet<std::io::Result<()>>,
    app: &Arc<App>,
    public: Option<TcpListener>,
    private: UnixListener,
    stop: &watch::Receiver<bool>,
) {
    if let Some(listener) = public {
        servers.spawn(http::serve_public(
            listener,
            app.clone(),
            stopped(stop.clone()),
        ));
    }
    servers.spawn(http::serve_control(
        private,
        app.clone(),
        stopped(stop.clone()),
    ));
}

/// Runs until a stop signal, and returns the status to exit with.
pub async fn run(accepted: Accepted) -> Result<u8, Failure> {
    let claim = Claim::take(&accepted.fixed().control_socket)?;
    let app = App::start(accepted).await?;
    let mut signals = Signals::install()?;

    let public = if app.settings.start.control_only {
        None
    } else {
        Some(bind_public(&app).await?)
    };
    let private = UnixListener::from_std(claim.bind()?)
        .map_err(|error| Failure::start(format!("The control socket failed: {error}")))?;

    let (stop, stopping) = watch::channel(false);
    let port = public
        .as_ref()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port());
    if let Some(port) = port {
        app.record_bound_port(port);
    }
    let mut servers = JoinSet::new();
    listen(&mut servers, &app, public, private, &stopping);
    tracing::info!("Private control socket listening");
    if let Some(port) = port {
        tracing::info!("Marfa server listening on port {port}");
    }
    if app.settings.start.test_hooks {
        tracing::warn!("Test hooks are on; this instance must hold no real data");
    }

    signals.next().await;
    tracing::info!("Stopping");
    app.faults.clear(None);
    let _ = stop.send(true);
    let closed = tokio::time::timeout(STOP_WAIT, servers.join_all()).await;
    if closed.is_err() {
        tracing::error!("A request was still open when the stop's wait ended");
    }
    app.db.close().await;
    claim.release();
    Ok(if closed.is_ok() { 0 } else { 1 })
}
