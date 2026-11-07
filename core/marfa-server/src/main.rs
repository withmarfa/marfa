//! An experimental Marfa server: a first slice of the contract, built on
//! `marfa-core` so the server and the working copy share one set of rules.

mod app;
mod auth;
mod body;
mod clock;
mod error;
mod health;
mod log;
mod observe;
mod routes;
mod schema;
mod settings;
mod storage;
mod write;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use clap::Parser;
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::watch;

use crate::app::App;
use crate::observe::Transport;
use crate::settings::Settings;

/// How long a stop waits for answers in flight before it lets them go.
const DRAIN: Duration = Duration::from_secs(5);

fn main() -> ExitCode {
    let settings = Settings::parse();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log::line("error", &format!("Marfa server could not start: {error}"));
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(settings)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            log::line("error", &format!("Marfa server could not start: {error}"));
            ExitCode::FAILURE
        }
    }
}

async fn run(settings: Settings) -> Result<(), String> {
    let app = App::open(settings)?;
    let (stop_tx, stop_rx) = watch::channel(false);

    let socket_path = app.settings.control_socket();
    let socket = bind_socket(&socket_path)?;
    let mut servers = tokio::task::JoinSet::new();
    {
        let router = routes::router(app.clone(), Transport::LocalSocket);
        let mut stop = stop_rx.clone();
        servers.spawn(async move {
            axum::serve(socket, router)
                .with_graceful_shutdown(async move {
                    let _ = stop.wait_for(|stopping| *stopping).await;
                })
                .await
        });
    }

    if !app.settings.control_only {
        let listener = bind_http(&app.settings).await?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("the listener has no address: {error}"))?
            .port();
        let router = routes::router(app.clone(), Transport::Http);
        let mut stop = stop_rx.clone();
        servers.spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stop.wait_for(|stopping| *stopping).await;
                })
                .await
        });
        log::line("info", &format!("Marfa server listening on port {port}"));
    } else {
        log::line("info", "Marfa server listening on its control socket only");
    }

    wait_for_stop().await;
    let _ = stop_tx.send(true);
    let drained = tokio::time::timeout(DRAIN, async {
        while let Some(result) = servers.join_next().await {
            if let Ok(Err(error)) = result {
                tracing::warn!("a listener stopped with an error: {error}");
            }
        }
    })
    .await;
    if drained.is_err() {
        tracing::warn!("answers still in flight after {DRAIN:?} were dropped");
        servers.abort_all();
    }
    let _ = std::fs::remove_file(&socket_path);
    app.close();
    log::line("info", "Marfa server stopped");
    Ok(())
}

async fn bind_http(settings: &Settings) -> Result<TcpListener, String> {
    let port = settings.port;
    match &settings.listen_host {
        Some(host) => TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|error| format!("cannot listen on {host}:{port}: {error}")),
        None => {
            let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port);
            match TcpListener::bind(v6).await {
                Ok(listener) => Ok(listener),
                Err(_) => {
                    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port))
                        .await
                        .map_err(|error| format!("cannot listen on port {port}: {error}"))
                }
            }
        }
    }
}

fn bind_socket(path: &Path) -> Result<UnixListener, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    // A socket file left by a server that did not stop cleanly.
    if std::os::unix::net::UnixStream::connect(path).is_err() {
        let _ = std::fs::remove_file(path);
    }
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("cannot bind {}: {error}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot restrict {}: {error}", path.display()))?;
    Ok(listener)
}

async fn wait_for_stop() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut terminate), Ok(mut interrupt)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        std::future::pending::<()>().await;
        return;
    };
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
}
