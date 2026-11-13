//! Backups in this instance's folder that the database never recorded, never deleted.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, Transaction, params};

use super::{Destination, Listing, OMISSIONS, parse};
use crate::app::App;
use crate::app::archive::restore::named::files_named;
use crate::app::blobs::Hash;
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
    omissions: i64,
}

fn found(tx: &Transaction<'_>, store: &str) -> Result<Vec<Found>> {
    Ok(tx
        .prepare_cached(
            "SELECT seq, name, files_read, omissions FROM found_backups WHERE store_id = ?1",
        )?
        .query_map([store], |row| {
            Ok(Found {
                seq: row.get(0)?,
                name: row.get(1)?,
                files_read: row.get(2)?,
                omissions: row.get(3)?,
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

/// Forgets every backup the server found in `store`, answering how many.
pub(super) fn forget_store(tx: &Transaction<'_>, store: &str) -> Result<usize> {
    tx.prepare_cached(
        "DELETE FROM found_backup_files WHERE seq IN \
         (SELECT seq FROM found_backups WHERE store_id = ?1)",
    )?
    .execute([store])?;
    Ok(tx
        .prepare_cached("DELETE FROM found_backups WHERE store_id = ?1")?
        .execute([store])?)
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
    let listing = Listing::of(listed);
    let mut counted =
        tx.prepare_cached("UPDATE found_backups SET omissions = ?2 WHERE seq = ?1")?;
    for backup in found(tx, store)? {
        if listed.contains(&backup.name) {
            if backup.omissions > 0 {
                counted.execute(params![backup.seq, 0])?;
            }
            continue;
        }
        let omissions = backup.omissions.saturating_add(1);
        if omissions >= OMISSIONS && listing.would_thin(&backup.name, now) {
            forget(tx, backup.seq)?;
        } else {
            counted.execute(params![backup.seq, omissions])?;
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
async fn read(app: &App, destination: &Destination, name: &str) -> Result<()> {
    let unreachable = |error: std::io::Error| {
        destination.unreachable("reading a backup this instance did not record", &error)
    };
    let got = destination
        .get(&app.instance_id, name, app.blobs.check())
        .await
        .map_err(unreachable)?;
    let Some((_, bytes)) = got else {
        return Ok(());
    };
    let files = files_named(bytes).await.map_err(unreachable)?;
    let files = files.unwrap_or_else(|| {
        tracing::warn!(backup = %name, "A backup in this instance's folder holds no manifest");
        Vec::new()
    });
    let (store, named) = (destination.id().to_string(), name.to_string());
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
pub(super) async fn survey(app: &App, destination: &Destination, listed: &[String]) -> Result<()> {
    let store = destination.id().to_string();
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
        read(app, destination, name).await?;
    }
    let (listed, now): (HashSet<String>, Stamp) =
        (listed.iter().cloned().collect(), app.clock.instant());
    app.db
        .write(Write::own(), move |tx| settle(tx, &store, &listed, now))
        .await
}

/// Lists this instance's folder and surveys it.
pub async fn survey_folder(app: &App) -> Result<()> {
    let Some(destination) = Destination::of(app) else {
        return Ok(());
    };
    let listed: Vec<String> = destination
        .list_in(&app.instance_id)
        .await
        .map_err(|error| destination.unreachable("listing this instance's backups", &error))?
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    survey(app, &destination, &listed).await
}
