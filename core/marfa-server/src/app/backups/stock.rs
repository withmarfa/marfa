//! What the destination holds of this instance's parts, and whether each holds the bytes its name
//! gives. A part the server stored or hashed is taken as whole while the destination lists it
//! with the tag it had then: an object store's ETag, or a backup folder's size, modified time and
//! inode. Any other part is hashed. A folder part is also hashed once its last hash is a week
//! old, a bounded number of bytes a run, since a change on a disk can keep all three.

use std::collections::{HashMap, HashSet};

use futures_util::StreamExt;
use rusqlite::{Transaction, params};

use super::parts::{self, Checked, Part};
use super::{Destination, Got, Stored};
use crate::app::App;
use crate::app::blobs::folder::Area;
use crate::app::clock::Stamp;
use crate::app::refusal::Result;
use crate::db::Write;

/// How long a folder part goes without being hashed before a run hashes it again.
const REHASH_AFTER_MS: i64 = 7 * 24 * 3_600_000;
/// About how many bytes of folder parts a run hashes again because their last hash is old.
const REHASH_BYTES: u64 = 512 * 1024 * 1024;

/// The parts the destination lists, what the database records of them, and what this run found.
pub(super) struct Stock {
    store: String,
    listed: HashMap<String, Stored>,
    /// The tag each part had when the server stored or last hashed it.
    tags: HashMap<String, String>,
    damaged: HashSet<String>,
    /// The parts this run hashes whatever their tag says.
    due: HashSet<String>,
    /// Whether each part looked at in this run holds the bytes its name gives, by the tag it was
    /// listed with then.
    seen: HashMap<String, (Option<String>, bool)>,
    /// The bytes this run read to hash parts.
    hashed: u64,
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

fn record_damaged(tx: &Transaction<'_>, store: &str, sha256: &str, at: &Stamp) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO backup_parts (store_id, sha256, hashed_at, damaged) VALUES (?1, ?2, ?3, 1) \
         ON CONFLICT (store_id, sha256) DO UPDATE SET tag = NULL, hashed_at = ?3, damaged = 1",
    )?
    .execute(params![store, sha256, at])?;
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

/// Records that the part `sha256` in the destination does not hold the bytes its name gives. A
/// failure to record it is logged: the restore or backup that found it says so either way.
pub(super) async fn found_damaged(app: &App, destination: &Destination, sha256: &str) {
    let (store, sha256, at) = (destination.id(), sha256.to_string(), app.clock.instant());
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

/// What reading a part whole found.
struct Hashed {
    whole: bool,
    /// The tag of the bytes that were read.
    tag: Option<String>,
    read: u64,
}

/// Reads the part in the destination whole and hashes it; `None` when it is not there.
async fn hashed(app: &App, destination: &Destination, part: &Part) -> Result<Option<Hashed>> {
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
    let Some(Got { tag, mut bytes, .. }) = got else {
        return Ok(None);
    };
    let mut checked = Checked::default();
    while let Some(chunk) = bytes.next().await {
        checked.update(&chunk.map_err(unreachable)?);
        if checked.size() > part.size_bytes {
            break;
        }
    }
    Ok(Some(Hashed {
        whole: checked.matches(part),
        tag,
        read: checked.size(),
    }))
}

/// The parts whose last hash is older than `after_ms` before `now`, never recorded, or recorded
/// in the future, oldest first, up to about `cap` bytes: the last one taken may pass it.
fn due(
    parts: Vec<(String, Option<Stamp>, u64)>,
    now: Stamp,
    after_ms: i64,
    cap: u64,
) -> Vec<String> {
    let stale = now.earlier_by(after_ms);
    let mut due: Vec<(String, Option<Stamp>, u64)> = parts
        .into_iter()
        .filter(|(_, at, _)| match at {
            None => true,
            Some(at) => *at > now || stale.is_some_and(|stale| *at <= stale),
        })
        .collect();
    due.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
    let mut taken = Vec::new();
    let mut total = 0u64;
    for (sha256, _, size) in due {
        if total >= cap {
            break;
        }
        total = total.saturating_add(size);
        taken.push(sha256);
    }
    taken
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
            due: HashSet::new(),
            seen: HashMap::new(),
            hashed: 0,
        };
        stock
            .relist(app, destination, "listing the backup's parts")
            .await?;
        let mut aging = Vec::new();
        let mut unread = 0usize;
        for row in rows {
            if row.damaged {
                stock.damaged.insert(row.sha256);
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
            if let Some(stored) = stock.listed.get(&row.sha256) {
                aging.push((row.sha256.clone(), hashed_at, stored.size));
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
            let now = app.clock.instant();
            stock.due = due(aging, now, REHASH_AFTER_MS, REHASH_BYTES)
                .into_iter()
                .collect();
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

    /// The bytes this run read to hash parts.
    pub(super) fn hashed(&self) -> u64 {
        self.hashed
    }

    /// Whether the destination holds `part` whole. A part listed with the tag recorded for it is
    /// taken as whole unless its hash is due; any other is hashed. A part there at another size,
    /// or that a hash shows altered, is recorded as damaged; one not there is not.
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
        let tag = stored.tag.clone();
        if let Some((seen_as, known)) = self.seen.get(sha256)
            && *seen_as == tag
        {
            return Ok(*known);
        }
        let found = if stored.size != part.size_bytes {
            Some((false, None))
        } else if tag.is_some()
            && !self.damaged.contains(sha256)
            && !self.due.contains(sha256)
            && self.tags.get(sha256) == tag.as_ref()
        {
            return Ok(true);
        } else {
            let hashed = hashed(app, destination, part).await?;
            self.hashed += hashed.as_ref().map_or(0, |hashed| hashed.read);
            hashed.map(|hashed| (hashed.whole, hashed.tag))
        };
        let whole = match found {
            Some((true, read_tag)) => {
                self.record(app, sha256, read_tag).await?;
                true
            }
            Some((false, _)) => {
                found_damaged(app, destination, sha256).await;
                self.damaged.insert(sha256.clone());
                self.tags.remove(sha256);
                false
            }
            None => false,
        };
        self.due.remove(sha256);
        self.seen.insert(sha256.clone(), (tag, whole));
        Ok(whole)
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
        self.due.remove(sha256);
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
            ("fresh".to_string(), at(99 * DAY_MS), 10),
            ("week".to_string(), at(93 * DAY_MS), 10),
            ("month".to_string(), at(70 * DAY_MS), 10),
            ("never".to_string(), None, 10),
            ("ahead".to_string(), at(101 * DAY_MS), 10),
            ("almost".to_string(), at(93 * DAY_MS + 1), 10),
        ];
        assert_eq!(
            due(parts, now, 7 * DAY_MS, u64::MAX),
            ["never", "month", "week", "ahead"]
        );
    }

    #[test]
    fn a_run_takes_due_parts_until_the_cap_and_always_one() {
        let now = Stamp::from_ms(100 * DAY_MS).unwrap();
        let parts: Vec<_> = (0..10)
            .map(|day| (format!("p{day}"), at(day * DAY_MS), 40))
            .collect();
        assert_eq!(due(parts.clone(), now, 7 * DAY_MS, 100), ["p0", "p1", "p2"]);
        assert_eq!(due(parts, now, 7 * DAY_MS, 1), ["p0"]);
        let large = vec![("large".to_string(), None, 1_000)];
        assert_eq!(due(large, now, 7 * DAY_MS, 100), ["large"]);
    }
}
