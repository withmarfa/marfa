//! What the server does. Nothing here names an HTTP type.

pub mod access;
pub mod audit;
pub mod catalog;
pub mod clock;
pub mod edge_types;
pub mod faults;
pub mod health;
pub mod instance;
pub mod keys;
pub mod refusal;
pub mod sources;
pub mod stored;
pub mod types;
pub mod unit;

use std::sync::Arc;

use arc_swap::ArcSwap;

use crate::db::migrate::MIGRATIONS;
use crate::db::{Db, Options, Write};
use crate::failure::Failure;
use crate::settings::Settings;
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
    catalog: Arc<ArcSwap<Catalog>>,
}

impl App {
    /// Opens the database and takes in what it holds.
    pub async fn start(settings: Settings) -> Result<Arc<App>, Failure> {
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
        settings
            .apply_stored(&rows)
            .map_err(|refused| Failure::start(refused.to_string()))?;
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
            catalog,
        }))
    }

    pub(crate) fn catalog_handle(&self) -> Arc<ArcSwap<Catalog>> {
        self.catalog.clone()
    }

    pub fn contract(&self) -> u32 {
        self.settings.start.contract_version.unwrap_or(0)
    }
}
