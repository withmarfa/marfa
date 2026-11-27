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
use crate::app::blobs::s3::names_one_object;
use crate::app::clock::Stamp;
use crate::app::refusal::{Code, Result};
use crate::db::Write;

/// How long a folder part goes without being hashed before a run hashes it again.
const REHASH_AFTER_MS: i64 = 7 * 24 * 3_600_000;
/// About how many bytes of folder parts, by their listed sizes, a run reads because their last
/// hash is old.
const REHASH_BYTES: u64 = 512 * 1024 * 1024;

/// The parts the destination lists, what the database records of them, and what this run found.
pub(super) struct Stock {
    store: String,
    listed: HashMap<String, Stored>,
    /// The tag each part had when the server stored or last hashed it.
    tags: HashMap<String, String>,
    /// The tag each damaged part had when it was found damaged; none where its read failed.
    damaged: HashMap<String, Option<String>>,
    /// The folder parts this run hashes because their last hash is old, oldest first.
    due: Vec<String>,
    /// Those of `due` this run has not hashed yet and a backup may still name.
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
/// the bytes its name gives or cannot be read. A failure to record it is logged: the restore or
/// backup that found it says so either way.
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
    /// The destination answers, and could not give the part's bytes for a reason of the part's.
    Unreadable(std::io::Error),
    Absent,
}

/// Reads the part `sha256` in the destination whole and hashes it, answering what it found and
/// how many bytes it read. A read that fails is the part's where the backup folder still answers
/// or the object store's error names that one object.
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

/// A failed read of one part, unless the read stalled, the backup folder no longer answers, or
/// the object store's answer does not name that one object.
async fn unreadable(destination: &Destination, error: std::io::Error) -> Result<Found> {
    match destination {
        Destination::Folder(folder) if error.kind() != std::io::ErrorKind::TimedOut => {
            let folder = folder.clone();
            if blocking(move || Ok(folder.reachable()))
                .await
                .unwrap_or(false)
            {
                return Ok(Found::Unreadable(error));
            }
        }
        Destination::Bucket(_) if names_one_object(&error) => {
            return Ok(Found::Unreadable(error));
        }
        _ => {}
    }
    Err(destination.unreachable("checking a part of the backup", &error))
}

/// Of the parts whose last hash is older than `after_ms` before `now`, never recorded, or
/// recorded in the future, the oldest first until their sizes reach `budget`, and always the
/// oldest one.
fn due(
    parts: Vec<(String, Option<Stamp>, u64)>,
    now: Stamp,
    after_ms: i64,
    budget: u64,
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
    let mut taken = 0u64;
    due.into_iter()
        .take_while(|(_, _, size)| {
            let room = taken < budget.max(1);
            taken = taken.saturating_add(*size);
            room
        })
        .map(|(sha256, _, _)| sha256)
        .collect()
}

impl Stock {
    /// Lists this instance's parts and reads what the database records of them.
    pub(super) async fn load(app: &App, destination: &Destination) -> Result<Stock> {
        Stock::loaded(app, destination, REHASH_BYTES).await
    }

    async fn loaded(app: &App, destination: &Destination, budget: u64) -> Result<Stock> {
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
            if let Some(listed) = stock.listed.get(&row.sha256) {
                aging.push((row.sha256.clone(), hashed_at, listed.size));
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
            stock.due = due(aging, app.clock.instant(), REHASH_AFTER_MS, budget);
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

    /// Takes the part `sha256` as one no backup names, which this run does not hash, whether or
    /// not its delete succeeds.
    pub(super) fn unnamed(&mut self, sha256: &str) {
        self.owed.remove(sha256);
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
    /// the tag recorded for it is taken as whole unless this run owes it a hash, and one listed
    /// with the tag it was found damaged with as damaged; any other is hashed. A part there at
    /// another size, that a hash shows altered, or that a backup folder or an object store, by an
    /// error naming that one object, cannot give is recorded as damaged; one not there is not.
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
                if trusted && !due {
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

    /// Hashes the folder parts this run owes a hash and has not read, oldest first, whichever
    /// backup names them. A part that cannot be read counts as damaged and the next is read; the
    /// pass stops where the folder does not answer.
    pub(super) async fn rehash_due(&mut self, app: &App, destination: &Destination) {
        for sha256 in std::mem::take(&mut self.due) {
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
            ("fresh".to_string(), at(99 * DAY_MS), 1),
            ("week".to_string(), at(93 * DAY_MS), 1),
            ("month".to_string(), at(70 * DAY_MS), 1),
            ("never".to_string(), None, 1),
            ("ahead".to_string(), at(101 * DAY_MS), 1),
            ("almost".to_string(), at(93 * DAY_MS + 1), 1),
        ];
        assert_eq!(
            due(parts, now, 7 * DAY_MS, u64::MAX),
            ["never", "month", "week", "ahead"]
        );
    }

    #[test]
    fn due_parts_stop_once_their_sizes_reach_the_budget_and_always_take_the_oldest() {
        let now = Stamp::from_ms(100 * DAY_MS).unwrap();
        let parts = || {
            vec![
                ("newer".to_string(), at(60 * DAY_MS), 10),
                ("newest".to_string(), at(80 * DAY_MS), 10),
                ("oldest".to_string(), at(50 * DAY_MS), 30),
            ]
        };
        assert_eq!(due(parts(), now, 7 * DAY_MS, 40), ["oldest", "newer"]);
        assert_eq!(due(parts(), now, 7 * DAY_MS, 30), ["oldest"]);
        assert_eq!(due(parts(), now, 7 * DAY_MS, 0), ["oldest"]);
        assert_eq!(
            due(parts(), now, 7 * DAY_MS, 41),
            ["oldest", "newer", "newest"]
        );
    }

    #[cfg(feature = "test-hooks")]
    mod runs {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Arc;

        use bytes::Bytes;
        use futures_util::stream;
        use rusqlite::OptionalExtension;
        use sha2::Digest;

        use super::super::*;
        use super::DAY_MS;
        use crate::app::archive;

        const SIZE: u64 = 1000;
        const PARTS: usize = 6;

        struct Folder {
            _dir: tempfile::TempDir,
            root: tempfile::TempDir,
            app: Arc<App>,
            destination: Destination,
            /// Oldest hash first.
            parts: Vec<Part>,
        }

        /// A server backing up to a folder that holds `PARTS` parts of `SIZE` bytes, each
        /// hashed a millisecond after the one before and all of them due.
        async fn folder() -> Folder {
            let (dir, root) = (
                tempfile::TempDir::new().unwrap(),
                tempfile::TempDir::new().unwrap(),
            );
            let (database, blobs, socket) = (
                dir.path().join("marfa.db"),
                dir.path().join("blobs"),
                dir.path().join("s.sock"),
            );
            let pairs = [
                ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
                ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
                ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
                ("MARFA_TEST_HOOKS", "true"),
                ("MARFA_BACKUP_PATH", root.path().to_str().unwrap()),
                ("MARFA_BACKUP_INTERVAL_SECONDS", "31536000"),
            ];
            let settings =
                crate::settings::Settings::read(crate::settings::Environment::from_pairs(&pairs))
                    .unwrap();
            let app = App::start(settings).await.unwrap();
            app.clock.pause(true);
            let destination = app.destination().await.unwrap();
            let mut stock = Stock::load(&app, &destination).await.unwrap();
            let mut made = Vec::new();
            for index in 0..PARTS {
                let bytes = vec![b'a' + index as u8; SIZE as usize];
                let sha256 = hex::encode(sha2::Sha256::digest(&bytes));
                let part = Part {
                    entry: archive::ROWS.to_string(),
                    sha256,
                    size_bytes: SIZE,
                    lines: 1,
                    mark: None,
                };
                let body = stream::once(async move { Ok(Bytes::from(bytes)) }).boxed();
                let (_, tag) = destination
                    .put(&app, Area::Parts, &parts::name_of(&part.sha256), SIZE, body)
                    .await
                    .unwrap();
                stock.stored(&app, &part, tag).await.unwrap();
                app.clock.advance(1).unwrap();
                made.push(part);
            }
            app.clock.advance(8 * DAY_MS as u64).unwrap();
            Folder {
                _dir: dir,
                root,
                app,
                destination,
                parts: made,
            }
        }

        impl Folder {
            async fn hashed_at(&self) -> Vec<Option<String>> {
                let mut found = Vec::new();
                for part in &self.parts {
                    let sha256 = part.sha256.clone();
                    found.push(
                        self.app
                            .db
                            .read(move |tx| {
                                Ok(tx
                                    .prepare_cached(
                                        "SELECT hashed_at FROM backup_parts WHERE sha256 = ?1",
                                    )?
                                    .query_row([sha256], |row| row.get(0))
                                    .optional()?
                                    .flatten())
                            })
                            .await
                            .unwrap(),
                    );
                }
                found
            }

            /// One run as a backup makes it, with room to hash two parts: the newest backup
            /// names the four newest parts and is checked newest first, then every part a
            /// backup names, then the parts still due.
            async fn run(&self) -> Stock {
                let mut stock = Stock::loaded(&self.app, &self.destination, 2 * SIZE)
                    .await
                    .unwrap();
                for part in self.parts.iter().skip(2).rev() {
                    stock
                        .whole(&self.app, &self.destination, part)
                        .await
                        .unwrap();
                }
                for part in &self.parts {
                    stock
                        .whole(&self.app, &self.destination, part)
                        .await
                        .unwrap();
                }
                stock.rehash_due(&self.app, &self.destination).await;
                self.app.clock.advance(1).unwrap();
                stock
            }

            async fn damaged(&self) -> u64 {
                let store = self.destination.id();
                self.app
                    .db
                    .read(move |tx| damaged(tx, &store))
                    .await
                    .unwrap()
            }
        }

        #[tokio::test]
        async fn due_parts_are_hashed_oldest_first_however_many_a_backup_checks_first() {
            let folder = folder().await;
            let mut before = folder.hashed_at().await;
            assert!(before.iter().all(Option::is_some));
            for run in 0..PARTS / 2 {
                folder.run().await;
                let after = folder.hashed_at().await;
                let read: Vec<usize> = (0..PARTS).filter(|at| after[*at] != before[*at]).collect();
                assert_eq!(read, [2 * run, 2 * run + 1], "run {run}");
                before = after;
            }
            assert_eq!(folder.damaged().await, 0);
        }

        #[tokio::test]
        async fn parts_that_fail_to_read_are_damaged_only_as_far_as_the_run_may_read() {
            let folder = folder().await;
            let parts = folder
                .root
                .path()
                .join("backup-parts")
                .join(&folder.app.instance_id);
            for part in &folder.parts {
                let path = parts.join(parts::name_of(&part.sha256));
                fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
                assert!(fs::read(&path).is_err(), "a part without permissions read");
            }
            folder.run().await;
            assert_eq!(folder.damaged().await, 2);
        }
    }
}
