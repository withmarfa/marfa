//! What the destination holds of this instance's parts, and whether each holds the bytes its name
//! gives. A part the server stored or hashed is taken as whole while the destination lists it
//! with the tag it had then: an object store's ETag, or a backup folder's stamp. Any other part is
//! hashed. A folder part is also hashed once its last hash is a week old, a bounded number of
//! bytes a run, since a change on a disk can keep its stamp. A part found damaged is read again
//! only once its tag changes.

use std::collections::{HashMap, HashSet};

use futures_util::StreamExt;
use rusqlite::{Transaction, params};

use super::parts::{self, Checked, Part};
use super::{Destination, Got, Stored, blocking};
use crate::app::App;
use crate::app::blobs::folder::Area;
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Result};
use crate::db::Write;

/// How long a folder part goes without being hashed before a run hashes it again.
const REHASH_AFTER_MS: i64 = 7 * 24 * 3_600_000;
/// About how many bytes of folder parts a run reads because their last hash is old.
const REHASH_BYTES: u64 = 512 * 1024 * 1024;

/// The parts the destination lists, what the database records of them, and what this run found.
pub(super) struct Stock {
    store: String,
    listed: HashMap<String, Stored>,
    /// The tag each part had when the server stored or last hashed it.
    tags: HashMap<String, String>,
    /// The tag each damaged part had when it was found damaged; none where its read failed.
    damaged: HashMap<String, Option<String>>,
    /// The folder parts whose last hash is old, oldest first, until this run reads them.
    due: Vec<String>,
    owed: HashSet<String>,
    /// Whether each part looked at in this run holds the bytes its name gives, by the tag it was
    /// listed with then.
    seen: HashMap<String, (Option<String>, bool)>,
    /// The bytes this run read to hash parts.
    hashed: u64,
    /// The bytes this run read of parts only because their hash was due.
    rehashed: u64,
}

struct Recorded {
    sha256: String,
    tag: Option<String>,
    hashed_at: Option<String>,
    damaged: bool,
}

fn recorded(tx: &Transaction<'_>, store: &str) -> Result<Vec<Recorded>> {
    Ok(tx
        .prepare_cached(
            "SELECT sha256, tag, hashed_at, damaged FROM backup_parts WHERE store_id = ?1",
        )?
        .query_map([store], |row| {
            Ok(Recorded {
                sha256: row.get(0)?,
                tag: row.get(1)?,
                hashed_at: row.get(2)?,
                damaged: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

fn record_whole(
    tx: &Transaction<'_>,
    store: &str,
    sha256: &str,
    tag: Option<&str>,
    at: &Stamp,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO backup_parts (store_id, sha256, tag, hashed_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (store_id, sha256) DO UPDATE SET tag = ?3, hashed_at = ?4, damaged = 0",
    )?
    .execute(params![store, sha256, tag, at])?;
    Ok(())
}

fn record_damaged(
    tx: &Transaction<'_>,
    store: &str,
    sha256: &str,
    tag: Option<&str>,
    at: &Stamp,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO backup_parts (store_id, sha256, tag, hashed_at, damaged) \
         VALUES (?1, ?2, ?3, ?4, 1) \
         ON CONFLICT (store_id, sha256) DO UPDATE SET tag = ?3, hashed_at = ?4, damaged = 1",
    )?
    .execute(params![store, sha256, tag, at])?;
    Ok(())
}

/// How many parts in `store` a check found damaged and the server has not stored again.
pub(super) fn damaged(tx: &Transaction<'_>, store: &str) -> Result<u64> {
    let count: i64 = tx
        .prepare_cached("SELECT count(*) FROM backup_parts WHERE store_id = ?1 AND damaged = 1")?
        .query_row([store], |row| row.get(0))?;
    Ok(count.max(0) as u64)
}

/// Forgets what the server recorded of the parts in `store`.
pub(super) fn forget_store(tx: &Transaction<'_>, store: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM backup_parts WHERE store_id = ?1")?
        .execute([store])?;
    Ok(())
}

/// Records that the part `sha256` in the destination, listed or read with `tag`, does not hold
/// the bytes its name gives. A failure to record it is logged: the restore or backup that found
/// it says so either way.
pub(super) async fn found_damaged(
    app: &App,
    destination: &Destination,
    sha256: &str,
    tag: Option<String>,
) {
    let (store, sha256, at) = (destination.id(), sha256.to_string(), app.clock.instant());
    let recorded = app
        .db
        .write(Write::own(), move |tx| {
            record_damaged(tx, &store, &sha256, tag.as_deref(), &at)
        })
        .await;
    if let Err(error) = recorded {
        tracing::warn!(error = %error.message, "A damaged part of a backup was not recorded");
    }
}

/// What looking at a part found.
enum Found {
    Whole(Option<String>),
    Damaged(Option<String>),
    /// A backup folder that answers could not give the part's bytes.
    Unreadable(std::io::Error),
    Absent,
}

/// Reads the part `sha256` in the destination whole and hashes it, answering what it found and
/// how many bytes it read. A read that fails is the part's where the backup folder still answers.
async fn hashed(
    app: &App,
    destination: &Destination,
    sha256: &str,
    size: u64,
) -> Result<(Found, u64)> {
    let got = destination
        .get(
            Area::Parts,
            &app.instance_id,
            &parts::name_of(sha256),
            app.blob_read_idle(),
        )
        .await;
    let Got { tag, mut bytes, .. } = match got {
        Ok(Some(got)) => got,
        Ok(None) => return Ok((Found::Absent, 0)),
        Err(error) => return Ok((unreadable(destination, error).await?, 0)),
    };
    let mut checked = Checked::default();
    while let Some(chunk) = bytes.next().await {
        match chunk {
            Ok(chunk) => checked.update(&chunk),
            Err(error) => return Ok((unreadable(destination, error).await?, checked.size())),
        }
        if checked.size() > size {
            break;
        }
    }
    let found = if checked.holds(sha256, size) {
        Found::Whole(tag)
    } else {
        Found::Damaged(tag)
    };
    Ok((found, checked.size()))
}

/// A failed read of one part, unless the destination is an object store, the read stalled, or the
/// backup folder no longer answers.
async fn unreadable(destination: &Destination, error: std::io::Error) -> Result<Found> {
    if let Destination::Folder(folder) = destination
        && error.kind() != std::io::ErrorKind::TimedOut
    {
        let folder = folder.clone();
        if blocking(move || Ok(folder.reachable()))
            .await
            .unwrap_or(false)
        {
            return Ok(Found::Unreadable(error));
        }
    }
    Err(destination.unreachable("checking a part of the backup", &error))
}

/// The parts whose last hash is older than `after_ms` before `now`, never recorded, or recorded
/// in the future, oldest first.
fn due(parts: Vec<(String, Option<Stamp>)>, now: Stamp, after_ms: i64) -> Vec<String> {
    let stale = now.earlier_by(after_ms);
    let mut due: Vec<(String, Option<Stamp>)> = parts
        .into_iter()
        .filter(|(_, at)| match at {
            None => true,
            Some(at) => *at > now || stale.is_some_and(|stale| *at <= stale),
        })
        .collect();
    due.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
    due.into_iter().map(|(sha256, _)| sha256).collect()
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
            damaged: HashMap::new(),
            due: Vec::new(),
            owed: HashSet::new(),
            seen: HashMap::new(),
            hashed: 0,
            rehashed: 0,
        };
        stock
            .relist(app, destination, "listing the backup's parts")
            .await?;
        let mut aging = Vec::new();
        let mut unread = 0usize;
        for row in rows {
            if row.damaged {
                stock.damaged.insert(row.sha256, row.tag);
                continue;
            }
            let Some(tag) = row.tag else {
                continue;
            };
            let hashed_at = row.hashed_at.and_then(|at| {
                let read = Stamp::parsed(&at);
                unread += usize::from(read.is_none());
                read
            });
            if stock.listed.contains_key(&row.sha256) {
                aging.push((row.sha256.clone(), hashed_at));
            }
            stock.tags.insert(row.sha256, tag);
        }
        if unread > 0 {
            tracing::warn!(
                count = unread,
                "Parts of the backup whose last hash time does not read are hashed again"
            );
        }
        if matches!(destination, Destination::Folder(_)) {
            stock.due = due(aging, app.clock.instant(), REHASH_AFTER_MS);
            stock.owed = stock.due.iter().cloned().collect();
        }
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

    /// Takes the part `sha256` as no longer listed, once this run deleted it.
    pub(super) fn deleted(&mut self, sha256: &str) {
        self.listed.remove(sha256);
    }

    /// The bytes this run read to hash parts.
    pub(super) fn hashed(&self) -> u64 {
        self.hashed
    }

    /// Whether the destination holds `part` whole, as `Stock::check` finds.
    pub(super) async fn whole(
        &mut self,
        app: &App,
        destination: &Destination,
        part: &Part,
    ) -> Result<bool> {
        self.check(app, destination, &part.sha256, part.size_bytes)
            .await
    }

    /// Whether the destination holds the part `sha256` whole at `size` bytes. A part listed with
    /// the tag recorded for it is taken as whole unless its hash is due, and one listed with the
    /// tag it was found damaged with as damaged; any other is hashed. A part there at another
    /// size, that a hash shows altered, or that a backup folder cannot give is recorded as
    /// damaged; one not there is not.
    async fn check(
        &mut self,
        app: &App,
        destination: &Destination,
        sha256: &str,
        size: u64,
    ) -> Result<bool> {
        let Some(stored) = self.listed.get(sha256) else {
            return Ok(false);
        };
        let tag = stored.tag.clone();
        if let Some((seen_as, known)) = self.seen.get(sha256)
            && *seen_as == tag
        {
            return Ok(*known);
        }
        let found = match self.damaged.get(sha256) {
            Some(Some(damaged_as)) if tag.as_ref() == Some(damaged_as) => {
                self.seen.insert(sha256.to_string(), (tag, false));
                return Ok(false);
            }
            _ if stored.size != size => Found::Damaged(tag.clone()),
            damaged => {
                let trusted =
                    tag.is_some() && damaged.is_none() && self.tags.get(sha256) == tag.as_ref();
                let due = trusted && self.owed.contains(sha256);
                if trusted && !(due && self.rehashed < REHASH_BYTES) {
                    return Ok(true);
                }
                let (found, read) = hashed(app, destination, sha256, size).await?;
                self.hashed += read;
                if due {
                    self.rehashed += read;
                }
                found
            }
        };
        let whole = match found {
            Found::Whole(read_tag) => {
                self.record(app, sha256, read_tag).await?;
                true
            }
            Found::Damaged(read_tag) => {
                self.found_damaged(app, destination, sha256, read_tag).await;
                false
            }
            Found::Unreadable(error) => {
                tracing::warn!(%error, "A part of the backup could not be read, so it counts as damaged");
                self.found_damaged(app, destination, sha256, None).await;
                false
            }
            Found::Absent => false,
        };
        self.owed.remove(sha256);
        self.seen.insert(sha256.to_string(), (tag, whole));
        Ok(whole)
    }

    async fn found_damaged(
        &mut self,
        app: &App,
        destination: &Destination,
        sha256: &str,
        tag: Option<String>,
    ) {
        found_damaged(app, destination, sha256, tag.clone()).await;
        self.damaged.insert(sha256.to_string(), tag);
        self.tags.remove(sha256);
    }

    /// Hashes the folder parts whose hash is due that this run has not read, oldest first, until
    /// it has read about `REHASH_BYTES` of them, whichever backup names them. A part that cannot
    /// be read counts as damaged and the next is read; the pass stops where the folder does not
    /// answer.
    pub(super) async fn rehash_due(&mut self, app: &App, destination: &Destination) {
        for sha256 in std::mem::take(&mut self.due) {
            if self.rehashed >= REHASH_BYTES {
                break;
            }
            if !self.owed.contains(&sha256) {
                continue;
            }
            let Some(size) = self.listed.get(&sha256).map(|stored| stored.size) else {
                continue;
            };
            if let Err(error) = self.check(app, destination, &sha256, size).await {
                tracing::warn!(error = %error.message, "A folder part whose hash was due was not checked");
                if error.code == Code::BlobStoreUnavailable {
                    break;
                }
            }
        }
        self.owed.clear();
        if self.rehashed > 0 {
            tracing::info!(
                read = self.rehashed,
                "Folder parts whose last hash was old were hashed again"
            );
        }
    }

    /// Records the part the server just stored, which is whole while it keeps the tag the
    /// destination answered.
    pub(super) async fn stored(
        &mut self,
        app: &App,
        part: &Part,
        tag: Option<String>,
    ) -> Result<()> {
        let sha256 = &part.sha256;
        self.listed.insert(
            sha256.clone(),
            Stored {
                size: part.size_bytes,
                tag: tag.clone(),
            },
        );
        self.record(app, sha256, tag).await?;
        self.seen.remove(sha256);
        self.owed.remove(sha256);
        Ok(())
    }

    async fn record(&mut self, app: &App, sha256: &str, tag: Option<String>) -> Result<()> {
        self.damaged.remove(sha256);
        match &tag {
            Some(tag) => self.tags.insert(sha256.to_string(), tag.clone()),
            None => self.tags.remove(sha256),
        };
        let (store, sha256, at) = (self.store.clone(), sha256.to_string(), app.clock.instant());
        app.db
            .write(Write::own(), move |tx| {
                record_whole(tx, &store, &sha256, tag.as_deref(), &at)
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

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 24 * 3_600_000;

    fn at(ms: i64) -> Option<Stamp> {
        Some(Stamp::from_ms(ms).unwrap())
    }

    #[test]
    fn only_parts_unhashed_for_a_week_or_never_are_due_oldest_first() {
        let now = Stamp::from_ms(100 * DAY_MS).unwrap();
        let parts = vec![
            ("fresh".to_string(), at(99 * DAY_MS)),
            ("week".to_string(), at(93 * DAY_MS)),
            ("month".to_string(), at(70 * DAY_MS)),
            ("never".to_string(), None),
            ("ahead".to_string(), at(101 * DAY_MS)),
            ("almost".to_string(), at(93 * DAY_MS + 1)),
        ];
        assert_eq!(
            due(parts, now, 7 * DAY_MS),
            ["never", "month", "week", "ahead"]
        );
    }
}
