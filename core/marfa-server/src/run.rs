use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use marfa_rules::update_record::keep_served_release;
use tokio::net::{TcpListener, UnixListener};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::watch;
use tokio::task::JoinSet;

use crate::app::auth::claim;
use crate::app::instance::VERSION;
use crate::app::{App, blocking, cloud, housekeeping, jobs, take_files, updates, webhooks};
use crate::control_socket::Claim;
use crate::failure::Failure;
use crate::http;
use crate::http::listening::{
    CONTROL_HEADER_READ_TIMEOUT, PUBLIC_HEADER_READ_TIMEOUT, Socket, Tcp,
};
use crate::http::{Caps, Entrance, Gate};
use crate::listener::Declaration;
use crate::open_files;
use crate::settings::Accepted;
use crate::telemetry::FLUSH_WITHIN;

/// Leaves room inside the ten seconds a container runtime gives a stop.
const STOP_WAIT: Duration = Duration::from_secs(7);
/// A stop that used all of the wait still has this long to send telemetry.
const FLUSH_AFTER_WAIT: Duration = Duration::from_millis(500);

async fn bind_public(app: &App) -> Result<TcpListener, Failure> {
    let start = &app.settings.start;
    let refused = |error: std::io::Error| {
        let port = start.port;
        Failure::start(if error.kind() == ErrorKind::AddrInUse {
            format!("The port {port} is already taken (EADDRINUSE)")
        } else {
            format!("The port {port} could not be bound: {error}")
        })
    };
    match &start.listen_host {
        Some(host) => TcpListener::bind((host.as_str(), start.port))
            .await
            .map_err(refused),
        None => match TcpListener::bind(("::", start.port)).await {
            Ok(listener) => Ok(listener),
            Err(error) if error.kind() == ErrorKind::AddrInUse => Err(refused(error)),
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

/// The connection caps, lowered to what the open-file limit leaves room for.
fn caps(app: &App) -> Caps {
    let start = &app.settings.start;
    let limit = open_files::raise();
    let (total, per_address) = open_files::fit(
        start.max_connections,
        start.max_connections_per_address,
        limit,
    );
    let open_files = limit.map_or_else(|| "unbounded".to_string(), |limit| limit.to_string());
    if total < start.max_connections {
        tracing::warn!(
            open_files,
            total,
            per_address,
            "The open-file limit leaves room for fewer connections than MARFA_MAX_CONNECTIONS"
        );
    } else {
        tracing::info!(open_files, total, per_address, "Connection caps");
    }
    Caps { total, per_address }
}

fn listen(
    servers: &mut JoinSet<std::io::Result<()>>,
    app: &Arc<App>,
    public: Option<TcpListener>,
    private: UnixListener,
) {
    if let Some(listener) = public {
        let gate = Gate::new(caps(app));
        let public = app.settings.start.public_listener.clone();
        servers.spawn(http::serve(
            Tcp::new(listener, public.name),
            http::public(app.clone()),
            stopped(app.stopping()),
            PUBLIC_HEADER_READ_TIMEOUT,
            Some(Entrance {
                gate: gate.clone(),
                trust: public.trust,
            }),
        ));
        // The tunnel listener shares the public listener's caps, which fit the open-file limit.
        cloud::tunnel::install(app, move |app, listener, stop| {
            let tunnel = Declaration::tunnel();
            let entrance = Entrance {
                gate: gate.clone(),
                trust: tunnel.trust.clone(),
            };
            Box::pin(http::serve(
                Tcp::new(listener, tunnel.name),
                http::public_on(app, tunnel),
                stop,
                PUBLIC_HEADER_READ_TIMEOUT,
                Some(entrance),
            ))
        });
    }
    servers.spawn(http::serve(
        Socket::new(private, Declaration::control().name),
        http::control(app.clone()),
        stopped(app.stopping()),
        CONTROL_HEADER_READ_TIMEOUT,
        None,
    ));
}

/// The command line reads the release an install is on from this while no server runs.
async fn keep_release(database: PathBuf) {
    let kept = tokio::task::spawn_blocking(move || keep_served_release(&database, VERSION))
        .await
        .map_err(std::io::Error::other)
        .and_then(|kept| kept);
    if let Err(error) = kept {
        tracing::warn!("The release serving the database could not be named beside it: {error}");
    }
}

pub async fn run(accepted: Accepted) -> Result<u8, Failure> {
    let fixed = accepted.fixed();
    let (database, blob_path) = (fixed.database.clone(), fixed.blob_path.clone());
    // Before the claim, so a second server on these files is refused for them, not the socket.
    let (kept, held) = blocking(move || {
        crate::private_files::make_data_folder(&database)?;
        take_files(&database, &blob_path)
    })
    .await?;
    let mut claim = Claim::take(&fixed.control_socket)?;
    let app = App::start_kept(accepted, kept, held).await?;
    let telemetry = app.telemetry.start(&app.instance_id, &app.settings);
    let mut signals = Signals::install()?;

    let public = if app.settings.start.control_only {
        None
    } else {
        Some(bind_public(&app).await?)
    };
    let private = UnixListener::from_std(claim.bind()?)
        .map_err(|error| Failure::start(format!("The control socket failed: {error}")))?;

    let bound = public
        .as_ref()
        .and_then(|listener| listener.local_addr().ok());
    if let Some(address) = bound {
        app.record_bound(address);
    }
    let port = bound.map(|address| address.port());
    claim::announce_at_start(&app)
        .await
        .map_err(|refusal| Failure::start(refusal.message.to_string()))?;
    let mut servers = JoinSet::new();
    listen(&mut servers, &app, public, private);
    if !app.settings.start.control_only {
        housekeeping::start(&app);
        webhooks::start(&app);
        jobs::start(&app);
        cloud::follow(&app);
    }
    tracing::info!("Private control socket listening");
    if let Some(port) = port {
        tracing::info!("Marfa server listening on port {port}");
    }
    #[cfg(feature = "test-hooks")]
    if app.settings.start.test_hooks {
        tracing::warn!("Test hooks are on; this instance must hold no real data");
    }
    if let Some(database) = app.settings.start.database.file() {
        keep_release(database).await;
    }

    updates::settle_when_up(&app);
    let restarting = tokio::select! {
        () = signals.next() => false,
        () = app.updates.restart_wanted() => true,
    };
    let stopping_at = Instant::now();
    tracing::info!("Stopping");
    app.housekeeping.stop();
    app.webhooks.stop();
    app.jobs.stop();
    app.cloud.stop();
    #[cfg(feature = "test-hooks")]
    app.faults.clear(None);
    app.begin_stop();
    let (closed, (), (), (), ()) = tokio::join!(
        tokio::time::timeout(STOP_WAIT, servers.join_all()),
        app.housekeeping.settle(STOP_WAIT),
        app.webhooks.settle(STOP_WAIT),
        app.jobs.settle(STOP_WAIT),
        app.cloud.settle(STOP_WAIT),
    );
    if closed.is_err() {
        tracing::error!("A request was still open when the stop's wait ended");
    }
    app.close().await;
    telemetry.stop(
        FLUSH_WITHIN.min((STOP_WAIT + FLUSH_AFTER_WAIT).saturating_sub(stopping_at.elapsed())),
    );
    claim.release();
    Ok(match (closed.is_ok(), restarting) {
        (true, true) => updates::RESTART_STATUS,
        (true, false) => 0,
        (false, _) => 1,
    })
}
