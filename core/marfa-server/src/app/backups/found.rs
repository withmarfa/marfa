//! Backups in this instance's folder that the database never recorded, such as those put after
//! the data directory it was restored from was copied. The server never deletes one, and keeps
//! every file one names while the store lists it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

use super::{FOLDER, LIST_DEADLINE, OMISSIONS, key_of, missing_past_retention, parse, unreachable};
use crate::app::App;
use crate::app::archive::restore::named::files_named;
use crate::app::blobs::Hash;
use crate::app::blobs::s3::S3;
use crate::app::blobs::store::{self, CHECK_DEADLINE};
use crate::app::clock::Stamp;
use crate::app::refusal::Result;
use crate::db::Write;

/// How many files one write of a found backup's holds records.
const PAGE: usize = 5_000;

/// A found backup as the database records it.
struct Found {
    seq: i64,
    name: String,
    files_read: bool,
    missing_since: Option<String>,
    omissions: i64,
}

fn found(tx: &Transaction<'_>, store: &str) -> Result<Vec<Found>> {
    Ok(tx
        .prepare_cached(
            "SELECT seq, name, files_read, missing_since, omissions FROM found_backups \
             WHERE store_id = ?1",
        )?
        .query_map([store], |row| {
            Ok(Found {
                seq: row.get(0)?,
                name: row.get(1)?,
                files_read: row.get(2)?,
                missing_since: row.get(3)?,
                omissions: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Whether the server found a backup named `name` in `store`.
pub fn recorded(tx: &Transaction<'_>, store: &str, name: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT 1 FROM found_backups WHERE store_id = ?1 AND name = ?2")?
        .exists(params![store, name])?)
}

/// Whether a backup of `store` the server found names `hash`.
pub fn names(tx: &Transaction<'_>, store: &str, hash: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT 1 FROM found_backup_files f JOIN found_backups b ON b.seq = f.seq \
             WHERE b.store_id = ?1 AND f.hash = ?2",
        )?
        .exists(params![store, hash])?)
}

fn forget(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached("DELETE FROM found_backup_files WHERE seq = ?1")?
        .execute([seq])?;
    tx.prepare_cached("DELETE FROM found_backups WHERE seq = ?1")?
        .execute([seq])?;
    Ok(())
}

/// Counts each found backup the listing omits, forgetting one omitted as `reconcile` forgets a
/// backup the server put.
pub(super) fn settle(
    tx: &Transaction<'_>,
    store: &str,
    listed: &HashSet<String>,
    now: Stamp,
) -> Result<()> {
    for backup in found(tx, store)? {
        if listed.contains(&backup.name) {
            if backup.missing_since.is_some() || backup.omissions > 0 {
                tx.prepare_cached(
                    "UPDATE found_backups SET missing_since = NULL, omissions = 0 WHERE seq = ?1",
                )?
                .execute([backup.seq])?;
            }
            continue;
        }
        let since = match backup.missing_since.as_deref().map(Stamp::parsed) {
            None => now,
            Some(Some(since)) => since,
            Some(None) => {
                tracing::error!(
                    backup = %backup.name,
                    "When listings began to omit a found backup does not read, so the files it \
                     names stay held"
                );
                continue;
            }
        };
        let omissions = backup.omissions.saturating_add(1);
        if omissions >= OMISSIONS && missing_past_retention(since, now) {
            forget(tx, backup.seq)?;
        } else {
            tx.prepare_cached(
                "UPDATE found_backups SET missing_since = ?2, omissions = ?3 WHERE seq = ?1",
            )?
            .execute(params![backup.seq, since, omissions])?;
        }
    }
    Ok(())
}

fn begin(tx: &Transaction<'_>, store: &str, name: &str) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO found_backups (store_id, name) VALUES (?1, ?2) \
         ON CONFLICT (store_id, name) DO NOTHING",
    )?
    .execute(params![store, name])?;
    tx.prepare_cached("SELECT seq FROM found_backups WHERE store_id = ?1 AND name = ?2")?
        .query_row(params![store, name], |row| row.get(0))
        .optional()?
        .ok_or_else(|| crate::app::refusal::Refusal::internal("a found backup was not kept"))
}

fn hold(tx: &Transaction<'_>, seq: i64, files: &[Hash]) -> Result<()> {
    let mut held = tx.prepare_cached(
        "INSERT INTO found_backup_files (seq, hash) VALUES (?1, ?2) \
         ON CONFLICT (seq, hash) DO NOTHING",
    )?;
    for hash in files {
        held.execute(params![seq, hash.as_str()])?;
    }
    Ok(())
}

/// Records every file the found backup `name` names, a page per write, and only then that its
/// files are read, so an interrupted read is read again.
async fn read(app: &App, bucket: &Arc<S3>, name: &str) -> Result<()> {
    let key = key_of(&app.instance_id, name);
    let got = store::within(CHECK_DEADLINE, bucket.get_whole(&key))
        .await
        .map_err(|error| unreachable("reading a backup this instance did not record", &error))?;
    let Some((_, bytes)) = got else {
        return Ok(());
    };
    let bytes = store::idle_limited(bytes, app.blobs.check());
    let files = files_named(bytes)
        .await
        .map_err(|error| unreachable("reading a backup this instance did not record", &error))?;
    let files = files.unwrap_or_else(|| {
        tracing::warn!(backup = %name, "A backup in this instance's folder holds no manifest");
        Vec::new()
    });
    let (store, named) = (bucket.id().to_string(), name.to_string());
    let seq = app
        .db
        .write(Write::own(), move |tx| begin(tx, &store, &named))
        .await?;
    for page in files.chunks(PAGE) {
        let page = page.to_vec();
        app.db
            .write(Write::own(), move |tx| hold(tx, seq, &page))
            .await?;
    }
    app.db
        .write(Write::own(), move |tx| {
            tx.prepare_cached("UPDATE found_backups SET files_read = 1 WHERE seq = ?1")?
                .execute([seq])?;
            Ok(())
        })
        .await
}

/// Records each backup `listed` in this instance's folder that the database records neither as
/// put nor as found, with the files it names, and settles the found ones the listing omits. Only
/// once this has succeeded do the found backups hold every file they name.
pub async fn survey(app: &App, bucket: &Arc<S3>, listed: &[String]) -> Result<()> {
    let store = bucket.id().to_string();
    let looked = store.clone();
    let (put, held) = app
        .db
        .read(move |tx| {
            let put: HashSet<String> = tx
                .prepare_cached("SELECT name FROM backups WHERE store_id = ?1")?
                .query_map([&looked], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let held: HashMap<String, bool> = found(tx, &looked)?
                .into_iter()
                .map(|found| (found.name, found.files_read))
                .collect();
            Ok((put, held))
        })
        .await?;
    let unread: Vec<&String> = listed
        .iter()
        .filter(|name| parse(name).is_some() && !put.contains(*name))
        .filter(|name| held.get(*name) != Some(&true))
        .collect();
    for name in unread {
        read(app, bucket, name).await?;
    }
    let (listed, now): (HashSet<String>, Stamp) =
        (listed.iter().cloned().collect(), app.clock.instant());
    app.db
        .write(Write::own(), move |tx| settle(tx, &store, &listed, now))
        .await
}

/// Lists this instance's folder and surveys it.
pub async fn survey_folder(app: &App) -> Result<()> {
    let Some(bucket) = app.blobs.s3() else {
        return Ok(());
    };
    let own = format!("{FOLDER}/{}", app.instance_id);
    let listed: Vec<String> = store::within(LIST_DEADLINE, bucket.list_in(&own))
        .await
        .map_err(|error| unreachable("listing this instance's backups", &error))?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    survey(app, &bucket, &listed).await
}
