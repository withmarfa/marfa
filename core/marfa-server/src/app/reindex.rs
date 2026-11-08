//! A type's write reindexes one page in its own transaction; a larger type goes on here a
//! page to a write, so the writer serves every other caller between pages. With nothing
//! queued the task sleeps until a type's door wakes it.

use std::sync::{Arc, Weak};

use tokio::sync::Notify;

use super::App;
use super::catalog::{self, Snapshot};
use super::items;
use super::refusal::Result;
use crate::db::Write;

pub fn start(app: &Arc<App>) {
    let wake = app.reindexing.clone();
    let app = Arc::downgrade(app);
    tokio::spawn(run(app, wake));
}

async fn run(app: Weak<App>, wake: Arc<Notify>) {
    loop {
        let more = match app.upgrade() {
            Some(app) => page(&app).await,
            None => return,
        };
        match more {
            Ok(true) => {}
            Ok(false) => wake.notified().await,
            Err(refusal) => {
                tracing::warn!(code = refusal.code.wire(), "A search reindex page failed");
                wake.notified().await;
            }
        }
    }
}

async fn page(app: &App) -> Result<bool> {
    let cache = app.catalog_handle();
    app.db
        .write(Write::own(), move |tx| {
            let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
            items::reindex_page(tx, &catalog.rules)
        })
        .await
}
