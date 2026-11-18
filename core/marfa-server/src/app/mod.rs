//! What the server does. Nothing here names an HTTP type.

pub mod access;
pub mod addresses;
pub mod archive;
pub mod attention;
pub mod audit;
pub mod auth;
pub mod backups;
pub mod blobs;
pub mod catalog;
pub mod clock;
pub mod config;
pub mod connectors;
pub mod consequences;
pub mod edge_types;
pub mod edges;
pub mod enrichment;
pub mod events;
pub mod faults;
pub mod folders;
pub mod health;
pub mod housekeeping;
pub mod idempotency;
pub mod inbound;
pub mod instance;
pub mod items;
pub mod jobs;
pub mod keys;
pub mod limiter;
pub mod mcp;
pub mod metrics;
pub mod oauth;
pub mod occurrences;
pub mod outbound;
pub mod overview;
pub mod provenance;
pub mod query;
pub mod refusal;
mod reindex;
pub mod restore_running;
pub mod sign_in_check;
pub mod sources;
pub mod stored;
pub mod tables;
pub mod types;
pub mod unit;
pub mod updates;
pub mod views;
pub mod webhooks;

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use arc_swap::ArcSwap;
use tokio::sync::{Notify, watch};

use crate::db::migrate::MIGRATIONS;
use crate::db::{Db, Lock, Options, Write};
use crate::failure::Failure;
use crate::private_files::Kept;
use crate::settings::{Accepted, DatabasePath, Settings};
use crate::telemetry::Telemetry;
use addresses::Addresses;
use auth::password::Passwords;
use blobs::Blobs;
use catalog::Catalog;
use clock::Clock;
use faults::Faults;
use health::Health;
use housekeeping::Housekeeping;
use keys::Usage;
use limiter::Limiter;
use query::Secret;

const READERS: usize = 4;

/// The contract version this build speaks, which `openapi.json` states.
const BUILT_CONTRACT: u32 = {
    assert!(marfa_rules::contract::CONTRACT_VERSION.leading_zeros() >= 32);
    marfa_rules::contract::CONTRACT_VERSION as u32
};

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Failure> + Send + 'static,
) -> Result<T, Failure> {
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        Failure::start(format!("The data's files could not be checked: {error}"))
    })?
}

pub struct App {
    pub db: Db,
    pub clock: Arc<Clock>,
    pub faults: Arc<Faults>,
    pub settings: Settings,
    pub instance_id: String,
    pub health: Health,
    pub usage: Usage,
    pub limiter: Limiter,
    pub refusal_records: auth::allowance::RefusalRecords,
    pub metrics: metrics::Permit,
    pub passwords: Passwords,
    pub housekeeping: Housekeeping,
    pub backups: backups::Backups,
    pub webhooks: webhooks::Webhooks,
    pub jobs: jobs::Jobs,
    pub blobs: Blobs,
    pub mcp: mcp::Mcp,
    pub devices: auth::device::Signer,
    pub challenges: auth::passkeys::Sealer,
    pub telemetry: Telemetry,
    pub started: Instant,
    pub cursor_secret: Secret,
    pub reindexing: Arc<Notify>,
    pub viewers: events::Viewers,
    pub attention: attention::Order,
    pub inbound: inbound::InFlight,
    pub updates: updates::Updates,
    stop: watch::Sender<bool>,
    catalog: Arc<ArcSwap<Catalog>>,
    read_only: Arc<ArcSwap<connectors::Registry>>,
    bound_port: OnceLock<u16>,
    pub(crate) documents: oauth::clients::Documents,
}

/// The locks a server holds on its database and blob folder while it runs.
pub struct Held {
    database: Lock,
    /// None where the blob folder has no marker yet; the store takes it when it opens the folder.
    blobs: Option<std::fs::File>,
}

/// Judges the server's files, takes their locks, and only then makes them private, so a second
/// server is refused before it changes anything of the first's. It blocks.
pub fn take_files(database: &DatabasePath, blobs: &Path) -> Result<(Kept, Held), Failure> {
    let judged = Kept::judged(database, blobs)?;
    // A running server has marked its folder; an unmarked one gets no lock file until it opens.
    let marked = judged.has_blob_folder() && blobs.join(blobs::MARKER).is_file();
    let held = Held {
        database: Lock::take(database)?,
        blobs: marked.then(|| blobs::lock_blobs(blobs)).transpose()?,
    };
    Ok((judged.keep()?, held))
}

impl App {
    pub async fn start(accepted: Accepted) -> Result<Arc<App>, Failure> {
        let fixed = accepted.fixed();
        let (database, blob_path) = (fixed.database.clone(), fixed.blob_path.clone());
        let (kept, held) = blocking(move || take_files(&database, &blob_path)).await?;
        App::start_kept(accepted, kept, held).await
    }

    /// Starts on the files [`take_files`] judged and locked, for a caller that must take them
    /// before it makes anything beside the database.
    pub async fn start_kept(
        accepted: Accepted,
        kept: Kept,
        held: Held,
    ) -> Result<Arc<App>, Failure> {
        let settings = accepted.open_secrets()?;
        let start = settings.start.clone();
        let faults = Arc::<Faults>::default();
        let options = Options {
            path: start.database.clone(),
            write_wait: start.tuning.write_wait,
            readers: READERS,
            migrations: MIGRATIONS,
            reserve: settings
                .live()
                .get(crate::settings::registry::DISK_RESERVE_BYTES),
        };
        let opening = faults.clone();
        let Held {
            database: database_lock,
            blobs: blob_lock,
        } = held;
        let db = tokio::task::spawn_blocking(move || Db::open(&options, database_lock, opening))
            .await
            .map_err(|error| Failure::start(format!("The database did not open: {error}")))??;
        let unreadable = |error| Failure::start(format!("The database could not be read: {error}"));
        let rows = db.read(stored::rows).await.map_err(unreadable)?;
        settings.apply_stored(&rows);
        stored::report_unknown(&rows);
        let instance_id = instance::identity(&db).await.map_err(unreadable)?;
        let cursor_secret = instance::cursor_secret(&db).await.map_err(unreadable)?;
        let mcp = mcp::Mcp::new(&start.auth_secret)
            .map_err(|refused| Failure::start(refused.to_string()))?;
        let devices = auth::device::Signer::derive(&start.auth_secret)
            .map_err(|refused| Failure::start(refused.to_string()))?;
        let challenges = auth::passkeys::Sealer::derive(&start.auth_secret)
            .map_err(|refused| Failure::start(refused.to_string()))?;
        #[cfg(feature = "test-hooks")]
        let clock = Arc::new(Clock::new(start.clock_offset_ms));
        #[cfg(not(feature = "test-hooks"))]
        let clock = Arc::new(Clock::default());
        clock.resume_from(db.read(clock::kept).await.map_err(unreadable)?);
        db.keep_clock(clock.clone());
        let at = clock.stamp();
        let blobs = Blobs::open(
            &db,
            (&start.blob_path, blob_lock),
            blobs::Beside {
                wanted: blobs::Wanted::of(&settings.live()),
                instance: &instance_id,
                kept: crate::settings::together::kept_folders(&start),
            },
            &start.auth_secret,
            faults.clone(),
            at.clone(),
        )
        .await?;
        blocking(move || kept.blobs_opened()).await?;
        db.write(Write::own(), move |tx| catalog::reconcile(tx, &at))
            .await
            .map_err(|refused| Failure::start(refused.to_string()))?;
        let catalog = Arc::new(ArcSwap::from_pointee(Catalog::empty()));
        let shared = catalog.clone();
        let loaded = db
            .read(move |tx| catalog::current(&shared, tx, catalog::Snapshot::Committed))
            .await
            .map_err(unreadable)?;
        for id in &loaded.unreadable {
            tracing::error!(type_id = %id, "A stored type does not read, and is kept as it is");
        }
        let app = Arc::new(App {
            db,
            clock,
            faults,
            settings,
            instance_id,
            cursor_secret,
            reindexing: Arc::new(Notify::new()),
            viewers: events::Viewers::default(),
            attention: attention::Order::default(),
            inbound: inbound::InFlight::default(),
            updates: updates::Updates::new(&start.database),
            stop: watch::channel(false).0,
            health: Health::default(),
            usage: Usage::default(),
            limiter: Limiter::default(),
            refusal_records: auth::allowance::RefusalRecords::default(),
            metrics: metrics::Permit::default(),
            passwords: Passwords::default(),
            housekeeping: Housekeeping::default(),
            backups: backups::Backups::default(),
            webhooks: webhooks::Webhooks::default(),
            jobs: jobs::Jobs::default(),
            blobs,
            mcp,
            devices,
            challenges,
            telemetry: Telemetry::default(),
            started: Instant::now(),
            catalog,
            read_only: Arc::new(ArcSwap::from_pointee(connectors::Registry::empty())),
            bound_port: OnceLock::new(),
            documents: oauth::clients::Documents::default(),
        });
        housekeeping::prepare(&app)
            .await
            .map_err(|refused| Failure::start(refused.to_string()))?;
        reindex::start(&app);
        Ok(app)
    }

    /// Raised once, when the stop begins; a stream reads it to end with `server_stopping`.
    pub fn stopping(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }

    pub fn begin_stop(&self) {
        self.stop.send_replace(true);
    }

    /// Closes the database and lets go of the folders, so another server may open them.
    pub async fn close(&self) {
        self.db.close().await;
        self.blobs.let_go();
    }

    pub(crate) fn catalog_handle(&self) -> Arc<ArcSwap<Catalog>> {
        self.catalog.clone()
    }

    pub(crate) fn read_only_handle(&self) -> Arc<ArcSwap<connectors::Registry>> {
        self.read_only.clone()
    }

    pub fn addresses(&self) -> Addresses {
        Addresses::read(&self.settings, self.bound_port.get().copied())
    }

    pub fn addresses_in(&self, snapshot: Arc<crate::settings::Snapshot>) -> Addresses {
        Addresses::in_snapshot(&self.settings, snapshot, self.bound_port.get().copied())
    }

    /// `MARFA_PORT=0` leaves the port to the operating system.
    pub fn record_bound_port(&self, port: u16) {
        let _ = self.bound_port.set(port);
    }

    #[cfg(feature = "test-hooks")]
    pub fn contract(&self) -> u32 {
        self.settings
            .start
            .contract_version
            .unwrap_or(BUILT_CONTRACT)
    }

    #[cfg(not(feature = "test-hooks"))]
    pub fn contract(&self) -> u32 {
        BUILT_CONTRACT
    }
}
