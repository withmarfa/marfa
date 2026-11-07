//! What the server does. Nothing here names an HTTP type.

pub mod clock;
pub mod faults;
pub mod health;
pub mod instance;
pub mod keys;
pub mod refusal;
pub mod stored;

use std::sync::Arc;

use crate::db::migrate::MIGRATIONS;
use crate::db::{Db, Options};
use crate::failure::Failure;
use crate::settings::Settings;
use clock::Clock;
use faults::Faults;
use health::Health;

const READERS: usize = 4;

/// The state every request shares.
pub struct App {
    pub db: Db,
    pub clock: Clock,
    pub faults: Arc<Faults>,
    pub settings: Settings,
    pub instance_id: String,
    pub health: Health,
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
        Ok(Arc::new(App {
            db,
            clock: Clock::new(start.clock_offset_ms),
            faults,
            settings,
            instance_id,
            health: Health::default(),
        }))
    }

    pub fn contract(&self) -> u32 {
        self.settings.start.contract_version.unwrap_or(0)
    }
}
