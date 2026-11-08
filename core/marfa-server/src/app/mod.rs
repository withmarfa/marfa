//! What the server does. Nothing here names an HTTP type.

pub mod access;
pub mod addresses;
pub mod audit;
pub mod auth;
pub mod catalog;
pub mod clock;
pub mod config;
pub mod consequences;
pub mod edge_types;
pub mod edges;
pub mod events;
pub mod faults;
pub mod health;
pub mod housekeeping;
pub mod idempotency;
pub mod instance;
pub mod items;
pub mod keys;
pub mod oauth;
pub mod query;
pub mod refusal;
mod reindex;
pub mod sources;
pub mod stored;
pub mod types;
pub mod unit;
pub mod views;

use std::sync::{Arc, OnceLock};

use arc_swap::ArcSwap;
use tokio::sync::Notify;

use crate::db::migrate::MIGRATIONS;
use crate::db::{Db, Options, Write};
use crate::failure::Failure;
use crate::settings::{Accepted, Settings};
use crate::telemetry::Telemetry;
use addresses::Addresses;
use auth::password::Passwords;
use catalog::Catalog;
use clock::Clock;
use faults::Faults;
use health::Health;
use housekeeping::Housekeeping;
use keys::{Limiter, Usage};
use query::Secret;

const READERS: usize = 4;

pub struct App {
    pub db: Db,
    pub clock: Arc<Clock>,
    pub faults: Arc<Faults>,
    pub settings: Settings,
    pub instance_id: String,
    pub health: Health,
    pub usage: Usage,
    pub key_limit: Limiter,
    pub passwords: Passwords,
    pub housekeeping: Housekeeping,
    pub telemetry: Telemetry,
    pub cursor_secret: Secret,
    pub reindexing: Arc<Notify>,
    catalog: Arc<ArcSwap<Catalog>>,
    bound_port: OnceLock<u16>,
    pub(crate) documents: oauth::clients::Documents,
}

impl App {
    pub async fn start(accepted: Accepted) -> Result<Arc<App>, Failure> {
        let settings = accepted.open_secrets()?;
        let start = settings.start.clone();
        let faults = Arc::new(Faults::default());
        let options = Options {
            path: start.database.clone(),
            busy_budget: start.busy_budget,
            readers: READERS,
            migrations: MIGRATIONS,
            migration_fault: start.migration_fault,
            free_disk_bytes: start.free_disk_bytes,
        };
        let opening = faults.clone();
        let db = tokio::task::spawn_blocking(move || Db::open(&options, opening))
            .await
            .map_err(|error| Failure::start(format!("The database did not open: {error}")))??;
        let unreadable = |error| Failure::start(format!("The database could not be read: {error}"));
        let rows = db.read(stored::rows).await.map_err(unreadable)?;
        settings.apply_stored(&rows);
        let instance_id = instance::identity(&db).await.map_err(unreadable)?;
        let cursor_secret = instance::cursor_secret(&db).await.map_err(unreadable)?;
        health::prepare_blobs(&start.blob_path)?;
        let clock = Arc::new(Clock::new(start.clock_offset_ms));
        let at = clock.stamp();
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
            health: Health::default(),
            usage: Usage::default(),
            key_limit: Limiter::default(),
            passwords: Passwords::default(),
            housekeeping: Housekeeping::default(),
            telemetry: Telemetry::default(),
            catalog,
            bound_port: OnceLock::new(),
            documents: oauth::clients::Documents::default(),
        });
        housekeeping::prepare(&app)
            .await
            .map_err(|refused| Failure::start(refused.to_string()))?;
        reindex::start(&app);
        Ok(app)
    }

    pub(crate) fn catalog_handle(&self) -> Arc<ArcSwap<Catalog>> {
        self.catalog.clone()
    }

    pub fn addresses(&self) -> Addresses {
        Addresses::read(&self.settings, self.bound_port.get().copied())
    }

    pub fn addresses_in(&self, snapshot: Arc<crate::settings::Snapshot>) -> Addresses {
        Addresses::in_snapshot(&self.settings, snapshot, self.bound_port.get().copied())
    }

    /// `PORT=0` leaves the port to the operating system.
    pub fn record_bound_port(&self, port: u16) {
        let _ = self.bound_port.set(port);
    }

    pub fn contract(&self) -> u32 {
        self.settings.start.contract_version.unwrap_or(0)
    }
}
