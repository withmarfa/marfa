use std::ops::Deref;
use std::sync::Arc;

use marfa_core::server::Catalog;

use crate::health::Health;
use crate::settings::Settings;
use crate::storage::{self, Db};

#[derive(Clone)]
pub struct App(Arc<Inner>);

pub struct Inner {
    pub settings: Settings,
    pub db: Arc<Db>,
    pub instance_id: String,
    /// The catalog every write is judged against, loaded once: this server
    /// registers no types, so it cannot change while it runs.
    pub catalog: Arc<Catalog>,
    pub health: Health,
}

impl Deref for App {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl App {
    pub fn open(settings: Settings) -> Result<App, String> {
        if settings.test_hooks {
            crate::clock::set_offset_ms(settings.test_clock_offset_ms);
        }
        let db = Db::open(&settings)?;
        db.writer_now(storage::catalog::seed)?;
        let (instance_id, catalog) = db.writer_now(|conn| {
            let id = storage::instance::instance_id(conn).map_err(|error| error.to_string())?;
            Ok::<_, String>((id, storage::catalog::load(conn)?))
        })?;
        crate::health::prepare_blobs(&settings.blob_path)?;
        Ok(App(Arc::new(Inner {
            health: Health::default(),
            settings,
            db: Arc::new(db),
            instance_id,
            catalog: Arc::new(catalog),
        })))
    }

    pub fn close(&self) {
        self.db.close();
    }
}
