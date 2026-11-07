//! What the server does. Nothing here names an HTTP type.

pub mod access;
pub mod addresses;
pub mod audit;
pub mod auth;
pub mod catalog;
pub mod clock;
pub mod edge_types;
pub mod events;
pub mod faults;
pub mod health;
pub mod idempotency;
pub mod instance;
pub mod items;
pub mod keys;
pub mod oauth;
pub mod refusal;
pub mod sources;
pub mod stored;
pub mod types;
pub mod unit;

use std::sync::{Arc, OnceLock};

use arc_swap::ArcSwap;

use crate::db::migrate::MIGRATIONS;
use crate::db::{Db, Options, Write};
use crate::failure::Failure;
use crate::settings::{Accepted, Settings};
use addresses::Addresses;
use auth::password::Passwords;
use catalog::Catalog;
use clock::Clock;
use faults::Faults;
use health::Health;
use keys::{Limiter, Usage};

const READERS: usize = 4;

/// The state every request shares.
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
    catalog: Arc<ArcSwap<Catalog>>,
    bound_port: OnceLock<u16>,
}

impl App {
    /// Opens the secrets and the database, and takes in what it holds.
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
        Ok(Arc::new(App {
            db,
            clock,
            faults,
            settings,
            instance_id,
            health: Health::default(),
            usage: Usage::default(),
            key_limit: Limiter::default(),
            passwords: Passwords::default(),
            catalog,
            bound_port: OnceLock::new(),
        }))
    }

    pub(crate) fn catalog_handle(&self) -> Arc<ArcSwap<Catalog>> {
        self.catalog.clone()
    }

    /// The instance's addresses as they stand now. `app.addresses().sign_in()`
    /// is the parsed sign-in address.
    pub fn addresses(&self) -> Addresses {
        Addresses::read(&self.settings, self.bound_port.get().copied())
    }

    /// Records the public port the server bound, which `PORT=0` leaves to the
    /// operating system.
    pub fn record_bound_port(&self, port: u16) {
        let _ = self.bound_port.set(port);
    }

    pub fn contract(&self) -> u32 {
        self.settings.start.contract_version.unwrap_or(0)
    }
}
