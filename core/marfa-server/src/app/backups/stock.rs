//! What the destination holds of this instance's parts, and whether each holds the bytes its name
//! gives. A backup folder proves it by hashing the file. An object store proves it by the ETag it
//! gave the object when the server stored or last hashed it: an object written since has another,
//! and is hashed again before it is taken as whole.

use std::collections::{HashMap, HashSet};

use futures_util::StreamExt;
use rusqlite::{Transaction, params};

use super::parts::{self, Checked, Part};
use super::{Destination, Stored};
use crate::app::App;
use crate::app::blobs::folder::Area;
use crate::app::refusal::Result;
use crate::db::Write;

/// The parts the destination lists, what the database records of them, and what this run found.
pub(super) struct Stock {
    store: String,
    listed: HashMap<String, Stored>,
    /// The ETag each part had when the server stored or last hashed it in an object store.
    tags: HashMap<String, String>,
    damaged: HashSet<String>,
    /// Whether each part looked at in this run holds the bytes its name gives.
    seen: HashMap<String, bool>,
}

struct Recorded {
    sha256: String,
    etag: Option<String>,
    damaged: bool,
}

fn recorded(tx: &Transaction<'_>, store: &str) -> Result<Vec<Recorded>> {
    Ok(tx
        .prepare_cached(
            "SELECT sha256, etag, damaged_at IS NOT NULL FROM backup_parts WHERE store_id = ?1",
        )?
        .query_map([store], |row| {
            Ok(Recorded {
                sha256: row.get(0)?,
                etag: row.get(1)?,
                damaged: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn record_whole(tx: &Transaction<'_>, store: &str, sha256: &str, etag: Option<&str>) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO backup_parts (store_id, sha256, etag) VALUES (?1, ?2, ?3) \
         ON CONFLICT (store_id, sha256) DO UPDATE SET etag = ?3, damaged_at = NULL",
    )?
    .execute(params![store, sha256, etag])?;
    Ok(())
}

fn record_damaged(tx: &Transaction<'_>, store: &str, sha256: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO backup_parts (store_id, sha256, damaged_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (store_id, sha256) DO UPDATE SET etag = NULL, \
         damaged_at = coalesce(damaged_at, ?3)",
    )?
    .execute(params![store, sha256, at])?;
    Ok(())
}

/// How many parts in `store` a check found damaged and the server has not stored again.
pub(super) fn damaged(tx: &Transaction<'_>, store: &str) -> Result<u64> {
    let count: i64 = tx
        .prepare_cached(
            "SELECT count(*) FROM backup_parts WHERE store_id = ?1 AND damaged_at IS NOT NULL",
        )?
        .query_row([store], |row| row.get(0))?;
    Ok(count.max(0) as u64)
}

/// Forgets what the server recorded of the parts in `store`.
pub(super) fn forget_store(tx: &Transaction<'_>, store: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM backup_parts WHERE store_id = ?1")?
        .execute([store])?;
    Ok(())
}

/// Records that the part `sha256` in the destination does not hold the bytes its name gives. A
/// failure to record it is logged: the restore or backup that found it says so either way.
pub(super) async fn found_damaged(app: &App, destination: &Destination, sha256: &str) {
    let (store, sha256, at) = (destination.id(), sha256.to_string(), app.clock.stamp());
    let recorded = app
        .db
        .write(Write::own(), move |tx| {
            record_damaged(tx, &store, &sha256, &at)
        })
        .await;
    if let Err(error) = recorded {
        tracing::warn!(error = %error.message, "A damaged part of a backup was not recorded");
    }
}

/// Whether the part in the destination holds `part`'s bytes, by reading it whole; `None` when it
/// is not there.
async fn hashed(app: &App, destination: &Destination, part: &Part) -> Result<Option<bool>> {
    let unreachable =
        |error: std::io::Error| destination.unreachable("checking a part of the backup", &error);
    let got = destination
        .get(
            Area::Parts,
            &app.instance_id,
            &parts::name_of(&part.sha256),
            app.blob_read_idle(),
        )
        .await
        .map_err(unreachable)?;
    let Some((_, mut bytes)) = got else {
        return Ok(None);
    };
    let mut checked = Checked::default();
    while let Some(chunk) = bytes.next().await {
        checked.update(&chunk.map_err(unreachable)?);
        if checked.size() > part.size_bytes {
            return Ok(Some(false));
        }
    }
    Ok(Some(checked.matches(part)))
}

impl Stock {
    /// Lists this instance's parts and reads what the database records of them.
    pub(super) async fn load(app: &App, destination: &Destination) -> Result<Stock> {
        let store = destination.id();
        let looked = store.clone();
        let rows = app.db.read(move |tx| recorded(tx, &looked)).await?;
        let mut stock = Stock {
            store,
            listed: HashMap::new(),
            tags: HashMap::new(),
            damaged: HashSet::new(),
            seen: HashMap::new(),
        };
        for row in rows {
            if row.damaged {
                stock.damaged.insert(row.sha256.clone());
            }
            if let Some(etag) = row.etag {
                stock.tags.insert(row.sha256, etag);
            }
        }
        stock
            .relist(app, destination, "listing the backup's parts")
            .await?;
        Ok(stock)
    }

    /// Lists the parts again, as they are after this run stored some.
    pub(super) async fn relist(
        &mut self,
        app: &App,
        destination: &Destination,
        what: &str,
    ) -> Result<()> {
        self.listed = destination
            .parts_in(&app.instance_id)
            .await
            .map_err(|error| destination.unreachable(what, &error))?;
        Ok(())
    }

    pub(super) fn listed(&self) -> &HashMap<String, Stored> {
        &self.listed
    }

    /// Whether the destination holds `part` whole. A backup folder's part is hashed, once a run.
    /// An object store's part is taken as whole while it has the ETag recorded for it, and
    /// hashed otherwise. A part there at another size, or that a hash shows altered, is recorded
    /// as damaged; one not there is not.
    pub(super) async fn whole(
        &mut self,
        app: &App,
        destination: &Destination,
        part: &Part,
    ) -> Result<bool> {
        let sha256 = &part.sha256;
        let Some(stored) = self.listed.get(sha256) else {
            return Ok(false);
        };
        let resized = stored.size != part.size_bytes;
        if let Some(known) = self.seen.get(sha256).filter(|_| !resized) {
            return Ok(*known);
        }
        let listed_tag = stored.etag.clone();
        let whole = if resized {
            Some(false)
        } else if matches!(destination, Destination::Bucket(_))
            && !self.damaged.contains(sha256)
            && listed_tag.is_some()
            && self.tags.get(sha256) == listed_tag.as_ref()
        {
            return Ok(true);
        } else {
            hashed(app, destination, part).await?
        };
        match whole {
            Some(true) => self.record(app, sha256, listed_tag).await?,
            Some(false) => {
                found_damaged(app, destination, sha256).await;
                self.damaged.insert(sha256.clone());
                self.tags.remove(sha256);
            }
            None => {}
        }
        let whole = whole == Some(true);
        self.seen.insert(sha256.clone(), whole);
        Ok(whole)
    }

    /// Records the part the server just stored: in a backup folder it is whole, and in an object
    /// store it is whole while it has the ETag the store answered.
    pub(super) async fn stored(
        &mut self,
        app: &App,
        destination: &Destination,
        part: &Part,
        etag: Option<String>,
    ) -> Result<()> {
        let sha256 = &part.sha256;
        self.listed.insert(
            sha256.clone(),
            Stored {
                size: part.size_bytes,
                etag: etag.clone(),
            },
        );
        self.record(app, sha256, etag).await?;
        match destination {
            Destination::Folder(_) => self.seen.insert(sha256.clone(), true),
            Destination::Bucket(_) => self.seen.remove(sha256),
        };
        Ok(())
    }

    async fn record(&mut self, app: &App, sha256: &str, etag: Option<String>) -> Result<()> {
        if !self.damaged.remove(sha256) && self.tags.get(sha256) == etag.as_ref() {
            return Ok(());
        }
        match &etag {
            Some(etag) => self.tags.insert(sha256.to_string(), etag.clone()),
            None => self.tags.remove(sha256),
        };
        let (store, sha256) = (self.store.clone(), sha256.to_string());
        app.db
            .write(Write::own(), move |tx| {
                record_whole(tx, &store, &sha256, etag.as_deref())
            })
            .await
    }

    /// Forgets what the server recorded of each part but those in `kept`.
    pub(super) async fn forget_others(&self, app: &App, kept: HashSet<String>) -> Result<()> {
        let store = self.store.clone();
        app.db
            .write(Write::own(), move |tx| {
                let gone: Vec<String> = recorded(tx, &store)?
                    .into_iter()
                    .map(|row| row.sha256)
                    .filter(|sha256| !kept.contains(sha256))
                    .collect();
                let mut forget = tx.prepare_cached(
                    "DELETE FROM backup_parts WHERE store_id = ?1 AND sha256 = ?2",
                )?;
                for sha256 in &gone {
                    forget.execute(params![store, sha256])?;
                }
                Ok(())
            })
            .await
    }
}
