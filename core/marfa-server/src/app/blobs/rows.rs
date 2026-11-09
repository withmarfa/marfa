//! The only SQL of the blob tables.

use std::collections::{BTreeMap, HashSet};

use rusqlite::types::ValueRef;
use rusqlite::{OptionalExtension, Transaction, params, params_from_iter};
use serde_json::Value;

use super::Blob;
use super::hash::Hash;
use super::references::Row;
use crate::app::clock::readable;
use crate::app::refusal::{Refusal, Result};

/// What the read rule asks of a row that lends a blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lender {
    Item {
        type_id: String,
    },
    Edge {
        edge_type: String,
        source_type: String,
    },
    Extension {
        namespace: String,
        item_type: String,
    },
}

/// A recorded copy: the store, and the object it is kept in there, which is empty for the
/// disk store, whose file the hash names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub store_id: String,
    pub object: String,
}

#[derive(Clone, Debug)]
pub struct CopyRecord {
    pub store_id: String,
    pub kind: String,
    pub detached: bool,
    pub recorded_at: String,
    pub verified_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StoreRecord {
    pub id: String,
    pub kind: String,
    pub locator: String,
    pub attached_at: String,
    pub detached_at: Option<String>,
}

fn unread(what: &str) -> Refusal {
    Refusal::internal(&format!("a stored {what} does not read"))
}

/// A stored object name, which must be empty for the disk store and, for an object store,
/// the blob's own hex and a name of one write, so that it can never name another blob.
fn object_of(hash: &Hash, kind: &str, object: String) -> Result<String> {
    let fits = match kind {
        "disk" => object.is_empty(),
        "s3" => object
            .strip_prefix(hash.hex())
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(|write| {
                !write.is_empty() && write.bytes().all(|byte| byte.is_ascii_hexdigit())
            }),
        _ => false,
    };
    if fits {
        Ok(object)
    } else {
        Err(unread("blob object"))
    }
}

pub fn find(tx: &Transaction<'_>, hash: &Hash) -> Result<Option<Blob>> {
    let row = tx
        .query_row(
            "SELECT mime_type, size_bytes FROM blobs WHERE hash = ?1",
            [hash.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    row.map(|(mime_type, size)| {
        Ok(Blob {
            hash: hash.clone(),
            mime_type,
            size_bytes: u64::try_from(size).map_err(|_| unread("blob size"))?,
        })
    })
    .transpose()
}

/// Each distinct lender costs at most four seeks, regardless of duplicate references.
pub fn lenders<'a, 'c>(tx: &'a Transaction<'c>, hash: &'a Hash) -> Lenders<'a, 'c> {
    Lenders {
        tx,
        hash,
        after: Some(Default::default()),
        deepest: 0,
    }
}

// Separate ranges avoid scanning duplicates with SQLite's row-value comparisons.
const LENDER_AFTER: [&str; 4] = [
    "SELECT kind, item_type, edge_type, namespace FROM blob_references \
     WHERE hash = ?1 AND lends = 1 AND kind > ?2 \
     ORDER BY kind, item_type, edge_type, namespace LIMIT 1",
    "SELECT kind, item_type, edge_type, namespace FROM blob_references \
     WHERE hash = ?1 AND lends = 1 AND kind = ?2 AND item_type > ?3 \
     ORDER BY item_type, edge_type, namespace LIMIT 1",
    "SELECT kind, item_type, edge_type, namespace FROM blob_references \
     WHERE hash = ?1 AND lends = 1 AND kind = ?2 AND item_type = ?3 AND edge_type > ?4 \
     ORDER BY edge_type, namespace LIMIT 1",
    "SELECT kind, item_type, edge_type, namespace FROM blob_references \
     WHERE hash = ?1 AND lends = 1 AND kind = ?2 AND item_type = ?3 AND edge_type = ?4 \
     AND namespace > ?5 ORDER BY namespace LIMIT 1",
];

pub struct Lenders<'a, 'c> {
    tx: &'a Transaction<'c>,
    hash: &'a Hash,
    /// The last answer read, or `None` once the walk has ended.
    after: Option<[String; 4]>,
    /// Only the first query has a bound before any answer is read.
    deepest: usize,
}

impl Lenders<'_, '_> {
    fn step(&self, after: &[String; 4]) -> Result<Option<[String; 4]>> {
        for depth in (0..=self.deepest).rev() {
            let bound = after[..=depth].iter().map(String::as_str);
            let found = self
                .tx
                .prepare_cached(LENDER_AFTER[depth])?
                .query_row(
                    params_from_iter(std::iter::once(self.hash.as_str()).chain(bound)),
                    |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?]),
                )
                .optional()?;
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }
}

impl Iterator for Lenders<'_, '_> {
    type Item = Result<Lender>;

    fn next(&mut self) -> Option<Self::Item> {
        let after = self.after.take()?;
        let [kind, item_type, edge_type, namespace] = match self.step(&after) {
            Ok(Some(found)) => {
                self.after = Some(found.clone());
                self.deepest = LENDER_AFTER.len() - 1;
                found
            }
            Ok(None) => return None,
            Err(error) => return Some(Err(error)),
        };
        Some(match kind.as_str() {
            "item" => Ok(Lender::Item { type_id: item_type }),
            "edge" => Ok(Lender::Edge {
                edge_type,
                source_type: item_type,
            }),
            "extension" => Ok(Lender::Extension {
                namespace,
                item_type,
            }),
            _ => Err(unread("reference")),
        })
    }
}

fn keyed(row: Row<'_>) -> (&'static str, i64, &str, i64) {
    match row {
        Row::Item(seq) => ("item", seq, "", 0),
        Row::Edge(seq) => ("edge", seq, "", 0),
        Row::Extension(seq, namespace) => ("extension", seq, namespace, 0),
        Row::Version(seq, version) => ("version", seq, "", version),
        Row::Owner => ("owner", 0, "", 0),
    }
}

/// Each digest the row names, and whether it lends.
pub fn references(tx: &Transaction<'_>, row: Row<'_>) -> Result<BTreeMap<String, bool>> {
    let (kind, seq, namespace, version) = keyed(row);
    let mut statement = tx.prepare_cached(
        "SELECT hash, lends FROM blob_references \
         WHERE kind = ?1 AND seq = ?2 AND namespace = ?3 AND version = ?4",
    )?;
    let rows = statement.query_map(params![kind, seq, namespace, version], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// The item type and edge type the read rule asks of a written row.
fn types(tx: &Transaction<'_>, row: Row<'_>) -> Result<(String, String)> {
    let found = match row {
        Row::Item(seq) | Row::Extension(seq, _) => tx
            .prepare_cached("SELECT type, '' FROM items WHERE seq = ?1")?
            .query_row([seq], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?,
        Row::Edge(seq) => tx
            .prepare_cached(
                "SELECT s.type, e.edge_type FROM edges e JOIN items s ON s.id = e.source_id \
                 WHERE e.seq = ?1",
            )?
            .query_row([seq], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?,
        Row::Version(..) | Row::Owner => Some((String::new(), String::new())),
    };
    found.ok_or_else(|| Refusal::internal("a reference names a row that is not written"))
}

/// A reference added takes its blob off the orphan report.
pub fn reference(tx: &Transaction<'_>, row: Row<'_>, hash: &str, lends: bool) -> Result<()> {
    let (kind, seq, namespace, version) = keyed(row);
    let (item_type, edge_type) = types(tx, row)?;
    tx.prepare_cached(
        "INSERT INTO blob_references \
         (hash, kind, seq, namespace, version, lends, item_type, edge_type) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        hash, kind, seq, namespace, version, lends, item_type, edge_type
    ])?;
    tx.prepare_cached("DELETE FROM blob_orphans WHERE hash = ?1")?
        .execute([hash])?;
    Ok(())
}

pub fn unreference(tx: &Transaction<'_>, row: Row<'_>, hash: &str) -> Result<()> {
    let (kind, seq, namespace, version) = keyed(row);
    tx.prepare_cached(
        "DELETE FROM blob_references \
         WHERE hash = ?1 AND kind = ?2 AND seq = ?3 AND namespace = ?4 AND version = ?5",
    )?
    .execute(params![hash, kind, seq, namespace, version])?;
    Ok(())
}

pub fn forget(tx: &Transaction<'_>, row: Row<'_>) -> Result<()> {
    let (kind, seq, namespace, version) = keyed(row);
    tx.prepare_cached(
        "DELETE FROM blob_references \
         WHERE kind = ?1 AND seq = ?2 AND namespace = ?3 AND version = ?4",
    )?
    .execute(params![kind, seq, namespace, version])?;
    Ok(())
}

/// The item, each of its namespaces and each of its versions.
pub fn forget_item(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached(
        "DELETE FROM blob_references WHERE kind IN ('item', 'extension', 'version') AND seq = ?1",
    )?
    .execute([seq])?;
    Ok(())
}

/// The version an item leaves behind names what the item named, and lends nothing.
pub fn keep_version(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO blob_references \
         (hash, kind, seq, namespace, version, lends, item_type, edge_type) \
         SELECT r.hash, 'version', r.seq, '', i.version, 0, '', '' \
         FROM blob_references r JOIN items i ON i.seq = r.seq \
         WHERE r.kind = 'item' AND r.seq = ?1",
    )?
    .execute([seq])?;
    Ok(())
}

pub fn proved(tx: &Transaction<'_>, hash: &str, holder: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT EXISTS (SELECT 1 FROM blob_proofs WHERE hash = ?1 AND holder = ?2)",
        )?
        .query_row(params![hash, holder], |row| row.get(0))?)
}

/// Records what an upload landed: the blob if it is new, the copy if none is recorded, and
/// the uploader's proof. A recorded blob keeps its type and a recorded copy its times.
pub fn record_upload(
    tx: &Transaction<'_>,
    blob: &Blob,
    store_id: &str,
    holder: Option<&str>,
    at: &str,
) -> Result<Blob> {
    let size = i64::try_from(blob.size_bytes).map_err(|_| unread("blob size"))?;
    tx.execute(
        "INSERT INTO blobs (hash, mime_type, size_bytes, recorded_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (hash) DO NOTHING",
        params![blob.hash.as_str(), blob.mime_type, size, at],
    )?;
    tx.execute(
        "INSERT INTO blob_copies (hash, store_id, recorded_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT (hash, store_id) DO NOTHING",
        params![blob.hash.as_str(), store_id, at],
    )?;
    if let Some(holder) = holder {
        tx.execute(
            "INSERT INTO blob_proofs (hash, holder) VALUES (?1, ?2) \
             ON CONFLICT (hash, holder) DO NOTHING",
            params![blob.hash.as_str(), holder],
        )?;
    }
    tx.execute(
        "DELETE FROM blob_orphans WHERE hash = ?1",
        [blob.hash.as_str()],
    )?;
    find(tx, &blob.hash)?.ok_or_else(|| unread("blob"))
}

/// Records a blob whose only copy is an object a store already holds, which `record_copy` names.
pub fn record_found(tx: &Transaction<'_>, blob: &Blob, at: &str) -> Result<()> {
    let size = i64::try_from(blob.size_bytes).map_err(|_| unread("blob size"))?;
    tx.execute(
        "INSERT INTO blobs (hash, mime_type, size_bytes, recorded_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (hash) DO NOTHING",
        params![blob.hash.as_str(), blob.mime_type, size, at],
    )?;
    tx.execute(
        "DELETE FROM blob_orphans WHERE hash = ?1",
        [blob.hash.as_str()],
    )?;
    Ok(())
}

pub fn copies(tx: &Transaction<'_>, hash: &Hash) -> Result<Vec<CopyRecord>> {
    let mut statement = tx.prepare_cached(
        "SELECT c.store_id, s.kind, s.detached_at IS NOT NULL, c.recorded_at, c.verified_at \
         FROM blob_copies c JOIN stores s ON s.id = c.store_id WHERE c.hash = ?1 \
         ORDER BY c.recorded_at, c.store_id",
    )?;
    let rows = statement.query_map([hash.as_str()], |row| {
        Ok(CopyRecord {
            store_id: row.get(0)?,
            kind: row.get(1)?,
            detached: row.get(2)?,
            recorded_at: row.get(3)?,
            verified_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn stores(tx: &Transaction<'_>) -> Result<Vec<StoreRecord>> {
    let mut statement = tx.prepare_cached(
        "SELECT id, kind, locator, attached_at, detached_at FROM stores \
         ORDER BY attached_at, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(StoreRecord {
            id: row.get(0)?,
            kind: row.get(1)?,
            locator: row.get(2)?,
            attached_at: row.get(3)?,
            detached_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn hash_of(text: &str) -> Result<Hash> {
    Hash::parse(text).map_err(|_| unread("blob hash"))
}

fn size_of(size: i64) -> Result<u64> {
    u64::try_from(size).map_err(|_| unread("blob size"))
}

/// A store found at start is attached, keeping the `attached_at` of its first attachment.
pub fn attach(tx: &Transaction<'_>, id: &str, kind: &str, locator: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO stores (id, kind, locator, attached_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT (id) DO UPDATE SET locator = excluded.locator, detached_at = NULL",
        params![id, kind, locator, at],
    )?;
    Ok(())
}

/// Every store the configuration no longer names is detached, from now.
pub fn detach_others(tx: &Transaction<'_>, kept: &[&str], at: &str) -> Result<()> {
    let kept = serde_json::to_string(kept).map_err(|_| unread("store id"))?;
    tx.execute(
        "UPDATE stores SET detached_at = ?2 WHERE detached_at IS NULL \
         AND id NOT IN (SELECT value FROM json_each(?1))",
        params![kept, at],
    )?;
    Ok(())
}

/// Whether an attached disk store recorded at this folder holds a copy.
pub fn copies_at_folder(tx: &Transaction<'_>, locator: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM stores s JOIN blob_copies c ON c.store_id = s.id \
         WHERE s.kind = 'disk' AND s.locator = ?1 AND s.detached_at IS NULL)",
        [locator],
        |row| row.get(0),
    )?)
}

/// The attached object store recorded at this locator.
pub fn attached_object_store(tx: &Transaction<'_>, locator: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT id FROM stores WHERE kind = 's3' AND locator = ?1 AND detached_at IS NULL \
             ORDER BY attached_at DESC, id LIMIT 1",
            [locator],
            |row| row.get(0),
        )
        .optional()?)
}

/// Whether the server has recorded an object store with this id, attached or not.
pub fn recorded_object_store(tx: &Transaction<'_>, id: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM stores WHERE id = ?1 AND kind = 's3')",
        [id],
        |row| row.get(0),
    )?)
}

/// Whether the registry holds a blob of this hash, written as `sha256:<hex>`.
pub fn registered(tx: &Transaction<'_>, hash: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT 1 FROM blobs WHERE hash = ?1")?
        .exists([hash])?)
}

/// The hashes `store_id` holds a recorded copy of, among `hashes`.
pub fn held_in(
    tx: &Transaction<'_>,
    store_id: &str,
    hashes: impl IntoIterator<Item = String>,
) -> Result<Vec<String>> {
    let mut statement =
        tx.prepare_cached("SELECT 1 FROM blob_copies WHERE hash = ?1 AND store_id = ?2")?;
    let mut held = Vec::new();
    for hash in hashes {
        if statement.exists(rusqlite::params![hash, store_id])? {
            held.push(hash);
        }
    }
    Ok(held)
}

/// The copies the copy record names in attached stores.
pub fn holders(tx: &Transaction<'_>, hash: &Hash) -> Result<Vec<Held>> {
    let mut statement = tx.prepare_cached(
        "SELECT c.store_id, s.kind, c.object FROM blob_copies c JOIN stores s ON s.id = c.store_id \
         WHERE c.hash = ?1 AND s.detached_at IS NULL ORDER BY c.store_id",
    )?;
    let rows = statement.query_map([hash.as_str()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (store_id, kind, object) = row?;
        let object = object_of(hash, &kind, object)?;
        found.push(Held { store_id, object });
    }
    Ok(found)
}

/// The objects whose deletion is queued in the store, each with whether a copy recorded there
/// names it.
pub fn deletion(tx: &Transaction<'_>, hash: &Hash, store_id: &str) -> Result<Vec<(String, bool)>> {
    let mut statement = tx.prepare_cached(
        "SELECT s.kind, p.object, EXISTS (SELECT 1 FROM blob_copies c \
                WHERE c.hash = p.hash AND c.store_id = p.store_id AND c.object = p.object) \
         FROM blob_pending_deletions p JOIN stores s ON s.id = p.store_id \
         WHERE p.hash = ?1 AND p.store_id = ?2 ORDER BY p.object",
    )?;
    let rows = statement.query_map(params![hash.as_str(), store_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, bool>(2)?,
        ))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (kind, object, recorded) = row?;
        found.push((object_of(hash, &kind, object)?, recorded));
    }
    Ok(found)
}

pub fn queue_deletion(
    tx: &Transaction<'_>,
    hash: &Hash,
    store_id: &str,
    object: &str,
    at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO blob_pending_deletions (hash, store_id, object, queued_at) \
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT (hash, store_id, object) DO NOTHING",
    )?
    .execute(params![hash.as_str(), store_id, object, at])?;
    Ok(())
}

pub fn deleted(tx: &Transaction<'_>, hash: &Hash, store_id: &str, object: &str) -> Result<()> {
    tx.prepare_cached(
        "DELETE FROM blob_pending_deletions WHERE hash = ?1 AND store_id = ?2 AND object = ?3",
    )?
    .execute(params![hash.as_str(), store_id, object])?;
    Ok(())
}

pub fn deletion_failed(
    tx: &Transaction<'_>,
    hash: &Hash,
    store_id: &str,
    object: &str,
    error: &str,
) -> Result<()> {
    tx.prepare_cached(
        "UPDATE blob_pending_deletions SET attempts = attempts + 1, last_error = ?4 \
         WHERE hash = ?1 AND store_id = ?2 AND object = ?3",
    )?
    .execute(params![hash.as_str(), store_id, object, error])?;
    Ok(())
}

/// Counts a replication run that did not copy the blob into the store.
pub fn copy_failed(tx: &Transaction<'_>, hash: &Hash, store_id: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO blob_copy_failures (hash, store_id, failures) \
         SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM blobs WHERE hash = ?1) \
         ON CONFLICT (hash, store_id) DO UPDATE SET failures = failures + 1",
    )?
    .execute(params![hash.as_str(), store_id])?;
    Ok(())
}

/// Records a copy a store now holds in `object`, unless the blob has left the registry since.
/// An object that a copy recorded meanwhile makes surplus stays queued for deletion.
pub fn record_copy(
    tx: &Transaction<'_>,
    hash: &Hash,
    store_id: &str,
    object: &str,
    at: &str,
) -> Result<bool> {
    if find(tx, hash)?.is_none() {
        return Ok(false);
    }
    let recorded = tx
        .prepare_cached(
            "INSERT INTO blob_copies (hash, store_id, object, recorded_at) \
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT (hash, store_id) DO NOTHING",
        )?
        .execute(params![hash.as_str(), store_id, object, at])?;
    tx.prepare_cached("DELETE FROM blob_copy_failures WHERE hash = ?1 AND store_id = ?2")?
        .execute(params![hash.as_str(), store_id])?;
    if recorded > 0 {
        deleted(tx, hash, store_id, object)?;
    }
    Ok(true)
}

/// Takes a copy out of the copy record and queues the deletion of its bytes, in one step.
pub fn remove_copy(
    tx: &Transaction<'_>,
    hash: &Hash,
    store_id: &str,
    object: &str,
    at: &str,
) -> Result<bool> {
    let removed = tx
        .prepare_cached(
            "DELETE FROM blob_copies WHERE hash = ?1 AND store_id = ?2 AND object = ?3",
        )?
        .execute(params![hash.as_str(), store_id, object])?;
    if removed == 0 {
        return Ok(false);
    }
    queue_deletion(tx, hash, store_id, object, at)?;
    Ok(true)
}

/// A blob an attached store lacks while another attached store holds it.
#[derive(Debug)]
pub struct Missing {
    pub blob: Blob,
    pub store_id: String,
}

const MISSING: &str = "FROM blobs b JOIN stores t ON t.detached_at IS NULL \
     LEFT JOIN blob_copy_failures f ON f.hash = b.hash AND f.store_id = t.id \
     WHERE NOT EXISTS (SELECT 1 FROM blob_copies c WHERE c.hash = b.hash AND c.store_id = t.id) \
     AND EXISTS (SELECT 1 FROM blob_copies c JOIN stores s ON s.id = c.store_id \
                 WHERE c.hash = b.hash AND s.detached_at IS NULL)";

pub fn missing(tx: &Transaction<'_>, limit: u64) -> Result<Vec<Missing>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT b.hash, b.mime_type, b.size_bytes, t.id {MISSING} \
         ORDER BY coalesce(f.failures, 0), b.recorded_at, b.hash, t.id LIMIT ?1"
    ))?;
    let rows = statement.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (hash, mime_type, size, store_id) = row?;
        found.push(Missing {
            blob: Blob {
                hash: hash_of(&hash)?,
                mime_type,
                size_bytes: size_of(size)?,
            },
            store_id,
        });
    }
    Ok(found)
}

pub fn missing_count(tx: &Transaction<'_>) -> Result<u64> {
    let count: i64 = tx.query_row(&format!("SELECT COUNT(*) {MISSING}"), [], |row| row.get(0))?;
    size_of(count)
}

/// Deletions waiting in attached stores, the fewest tried and the longest queued first.
pub fn pending_deletions(
    tx: &Transaction<'_>,
    limit: u64,
    unregistered_only: bool,
) -> Result<Vec<(Hash, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT p.hash, p.store_id FROM blob_pending_deletions p \
         JOIN stores s ON s.id = p.store_id \
         WHERE s.detached_at IS NULL \
         AND (?2 = 0 OR NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = p.hash)) \
         ORDER BY p.attempts, p.queued_at, p.hash, p.store_id LIMIT ?1",
    )?;
    let rows = statement.query_map(
        params![i64::try_from(limit).unwrap_or(i64::MAX), unregistered_only],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let mut found = Vec::new();
    for row in rows {
        let (hash, store_id) = row?;
        found.push((hash_of(&hash)?, store_id));
    }
    Ok(found)
}

/// A copy to check, with the size its blob is recorded at.
#[derive(Debug)]
pub struct ToCheck {
    pub hash: Hash,
    pub size: u64,
    pub store_id: String,
    pub object: String,
}

/// Copies in attached stores, never checked first and then the least recently checked, across
/// every store but those left out.
pub fn to_check(tx: &Transaction<'_>, left_out: &[String], limit: u64) -> Result<Vec<ToCheck>> {
    let left_out = serde_json::to_string(left_out).map_err(|_| unread("store id"))?;
    let mut statement = tx.prepare_cached(
        "SELECT c.hash, b.size_bytes, c.store_id, s.kind, c.object FROM blob_copies c \
         JOIN blobs b ON b.hash = c.hash JOIN stores s ON s.id = c.store_id \
         WHERE s.detached_at IS NULL AND c.store_id NOT IN (SELECT value FROM json_each(?1)) \
         ORDER BY c.verified_at IS NOT NULL, c.verified_at, c.hash, c.store_id LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![left_out, i64::try_from(limit).unwrap_or(i64::MAX)],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        },
    )?;
    let mut found = Vec::new();
    for row in rows {
        let (hash, size, store_id, kind, object) = row?;
        let hash = hash_of(&hash)?;
        let object = object_of(&hash, &kind, object)?;
        found.push(ToCheck {
            hash,
            size: size_of(size)?,
            store_id,
            object,
        });
    }
    Ok(found)
}

/// Stamps the copy only while it is still the object that was checked.
pub fn verified(
    tx: &Transaction<'_>,
    hash: &Hash,
    store_id: &str,
    object: &str,
    at: &str,
) -> Result<bool> {
    let stamped = tx
        .prepare_cached(
            "UPDATE blob_copies SET verified_at = ?4 \
             WHERE hash = ?1 AND store_id = ?2 AND object = ?3",
        )?
        .execute(params![hash.as_str(), store_id, object, at])?;
    Ok(stamped > 0)
}

/// Adds every blob nothing references to the report, keeping the time of an earlier report,
/// and takes off any that something references now. Answers the report's size.
pub fn report_orphans(tx: &Transaction<'_>, at: &str) -> Result<u64> {
    tx.execute(
        "INSERT INTO blob_orphans (hash, reported_at) SELECT b.hash, ?1 FROM blobs b \
         WHERE NOT EXISTS (SELECT 1 FROM blob_references r WHERE r.hash = b.hash) \
         ON CONFLICT (hash) DO NOTHING",
        [at],
    )?;
    tx.execute(
        "DELETE FROM blob_orphans WHERE hash IN (SELECT hash FROM blob_references)",
        [],
    )?;
    report_size(tx)
}

pub fn report_size(tx: &Transaction<'_>) -> Result<u64> {
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM blob_orphans", [], |row| row.get(0))?;
    size_of(count)
}

/// Blobs reported at or before `cutoff` that the index says nothing references.
pub fn purge_candidates(tx: &Transaction<'_>, cutoff: &str) -> Result<Vec<Hash>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT o.hash FROM blob_orphans o WHERE {} AND o.reported_at <= ?1 \
         AND NOT EXISTS (SELECT 1 FROM blob_references r WHERE r.hash = o.hash) \
         ORDER BY o.reported_at, o.hash",
        readable("o.reported_at")
    ))?;
    let rows = statement.query_map([cutoff], |row| row.get::<_, String>(0))?;
    let mut found = Vec::new();
    for row in rows {
        found.push(hash_of(&row?)?);
    }
    Ok(found)
}

pub fn unreport(tx: &Transaction<'_>, hash: &Hash) -> Result<()> {
    tx.prepare_cached("DELETE FROM blob_orphans WHERE hash = ?1")?
        .execute([hash.as_str()])?;
    Ok(())
}

/// The rows whose stored properties a digest can stand in, and the column that holds them.
const NAMING: [(&str, &str); 4] = [
    ("items", "properties"),
    ("item_extensions", "data"),
    ("edges", "properties"),
    ("item_versions", "properties"),
];

/// Of `candidates` (the hex of each), those a stored row names, read from the rows themselves
/// in one pass rather than from the index.
pub fn named(tx: &Transaction<'_>, candidates: &HashSet<String>) -> Result<HashSet<String>> {
    let windows: HashSet<&[u8]> = candidates.iter().map(|hex| hex.as_bytes()).collect();
    let mut found = HashSet::new();
    for (table, column) in NAMING {
        let mut hits = Vec::new();
        {
            let mut statement = tx.prepare(&format!("SELECT rowid, {column} FROM {table}"))?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let raw = match row.get_ref(1)? {
                    ValueRef::Blob(bytes) | ValueRef::Text(bytes) => bytes,
                    _ => continue,
                };
                if may_name(raw, &windows) {
                    hits.push(row.get::<_, i64>(0)?);
                }
            }
        }
        let mut read = tx.prepare(&format!(
            "SELECT json({column}) FROM {table} WHERE rowid = ?1"
        ))?;
        for rowid in hits {
            let text: Option<String> = read.query_row([rowid], |row| row.get(0)).optional()?;
            let Some(Ok(value)) = text.map(|text| serde_json::from_str::<Value>(&text)) else {
                tracing::error!(
                    table,
                    rowid,
                    "A stored row does not read, so every blob is kept"
                );
                return Ok(candidates.clone());
            };
            let properties = match value {
                Value::Object(properties) => properties,
                other => serde_json::Map::from_iter([(String::new(), other)]),
            };
            for digest in super::digests::digests(&properties) {
                if let Some(hex) = digest.strip_prefix("sha256:")
                    && candidates.contains(hex)
                {
                    found.insert(hex.to_string());
                }
            }
        }
    }
    Ok(found)
}

/// Whether stored bytes could hold one of the hex names once read: a run of 64 or more
/// lowercase hex holding one, or an escape that reading could turn into hex. Never narrower
/// than the digest rule, so a row it passes over names none of them.
fn may_name(raw: &[u8], names: &HashSet<&[u8]>) -> bool {
    const HEX_LEN: usize = 64;
    let is_hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    if raw
        .windows(2)
        .any(|pair| pair[0] == b'\\' && matches!(pair[1], b'u' | b'x'))
    {
        return true;
    }
    let mut at = 0;
    while at < raw.len() {
        if !is_hex(raw[at]) {
            at += 1;
            continue;
        }
        let start = at;
        while at < raw.len() && is_hex(raw[at]) {
            at += 1;
        }
        if at - start >= HEX_LEN
            && raw[start..at]
                .windows(HEX_LEN)
                .any(|window| names.contains(window))
        {
            return true;
        }
    }
    false
}

/// Takes a blob out of the registry with its copies, proofs and report, and queues the
/// deletion of its bytes in each attached store: every object recorded in an object store, and
/// the file the hash names in a disk store, which a write the server gave up on may have left.
pub fn purge(tx: &Transaction<'_>, hash: &Hash, at: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO blob_pending_deletions (hash, store_id, object, queued_at) \
         SELECT c.hash, c.store_id, c.object, ?2 FROM blob_copies c \
         JOIN stores s ON s.id = c.store_id \
         WHERE c.hash = ?1 AND s.kind = 's3' AND s.detached_at IS NULL \
         ON CONFLICT (hash, store_id, object) DO NOTHING",
    )?
    .execute(params![hash.as_str(), at])?;
    tx.prepare_cached(
        "INSERT INTO blob_pending_deletions (hash, store_id, object, queued_at) \
         SELECT ?1, id, '', ?2 FROM stores WHERE kind = 'disk' AND detached_at IS NULL \
         ON CONFLICT (hash, store_id, object) DO NOTHING",
    )?
    .execute(params![hash.as_str(), at])?;
    for table in [
        "blob_copies",
        "blob_copy_failures",
        "blob_proofs",
        "blob_orphans",
    ] {
        tx.prepare_cached(&format!("DELETE FROM {table} WHERE hash = ?1"))?
            .execute([hash.as_str()])?;
    }
    tx.prepare_cached("DELETE FROM blobs WHERE hash = ?1")?
        .execute([hash.as_str()])?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct OrphanRecord {
    pub blob: Blob,
    pub reported_at: String,
}

pub fn orphans(tx: &Transaction<'_>) -> Result<Vec<OrphanRecord>> {
    let mut statement = tx.prepare_cached(
        "SELECT o.hash, b.mime_type, b.size_bytes, o.reported_at FROM blob_orphans o \
         JOIN blobs b ON b.hash = o.hash ORDER BY o.reported_at, o.hash",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut found = Vec::new();
    for row in rows {
        let (hash, mime_type, size, reported_at) = row?;
        found.push(OrphanRecord {
            blob: Blob {
                hash: hash_of(&hash)?,
                mime_type,
                size_bytes: size_of(size)?,
            },
            reported_at,
        });
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, StatementStatus};

    use super::*;
    use crate::db::migrate::MIGRATIONS;

    fn lent(tx: &Transaction<'_>, hash: &Hash, seq: i64, kind: &str, types: [&str; 3]) {
        tx.execute(
            "INSERT INTO blob_references \
             (hash, kind, seq, namespace, version, lends, item_type, edge_type) \
             VALUES (?1, ?2, ?3, ?4, 0, 1, ?5, ?6)",
            params![hash.as_str(), kind, seq, types[2], types[0], types[1]],
        )
        .unwrap();
    }

    #[test]
    fn the_lenders_walk_one_seek_per_distinct_answer_however_many_rows_lend() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0].sql).unwrap();
        let tx = conn.transaction().unwrap();
        let hash = Hash::parse(&format!("sha256:{}", "a".repeat(64))).unwrap();
        let other = Hash::parse(&format!("sha256:{}", "b".repeat(64))).unwrap();
        for seq in 0..2_000 {
            lent(&tx, &hash, seq, "item", ["core.note", "", ""]);
            lent(&tx, &hash, seq, "extension", ["core.note", "", "acme"]);
            lent(&tx, &other, seq, "item", ["core.task", "", ""]);
        }
        lent(&tx, &hash, 1, "edge", ["core.note", "parent-of", ""]);
        lent(&tx, &hash, 9_000, "item", ["core.task", "", ""]);
        tx.execute(
            "UPDATE blob_references SET lends = 0 WHERE hash = ?1 AND seq = 9000",
            [hash.as_str()],
        )
        .unwrap();

        let walked: Vec<Lender> = lenders(&tx, &hash).map(Result::unwrap).collect();
        assert_eq!(
            walked,
            vec![
                Lender::Edge {
                    edge_type: "parent-of".into(),
                    source_type: "core.note".into(),
                },
                Lender::Extension {
                    namespace: "acme".into(),
                    item_type: "core.note".into(),
                },
                Lender::Item {
                    type_id: "core.note".into(),
                },
            ]
        );

        let steps: i32 = LENDER_AFTER
            .iter()
            .map(|sql| {
                let statement = tx.prepare_cached(sql).unwrap();
                statement.get_status(StatementStatus::VmStep)
            })
            .sum();
        assert!(
            steps < 1_000,
            "{steps} steps for 4,000 rows that lend alike"
        );
        for (depth, sql) in LENDER_AFTER.iter().enumerate() {
            let bound = vec![""; depth + 2];
            let plan: Vec<String> = tx
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map(params_from_iter(bound), |row| row.get(3))
                .unwrap()
                .map(|detail| detail.unwrap())
                .collect();
            let plan = plan.join("; ");
            assert!(plan.contains("COVERING INDEX blob_lenders"), "{plan}");
            assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        }
    }

    const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn names() -> HashSet<&'static [u8]> {
        HashSet::from([HEX.as_bytes()])
    }

    #[test]
    fn a_row_may_name_a_candidate_inside_a_longer_hex_run_or_behind_an_escape() {
        for raw in [
            format!("see sha256:{HEX}."),
            format!("sha256%3a{HEX}"),
            format!("ab{HEX}cd"),
            "an escape \\u0030 hides a digest".to_string(),
        ] {
            assert!(may_name(raw.as_bytes(), &names()), "{raw}");
        }
    }

    #[test]
    fn a_row_without_a_candidate_is_passed_over() {
        let other = "f".repeat(64);
        for raw in [
            String::new(),
            other,
            HEX[..63].to_string(),
            HEX.to_uppercase(),
            format!("{} {}", &HEX[..32], &HEX[32..]),
        ] {
            assert!(!may_name(raw.as_bytes(), &names()), "{raw}");
        }
    }
}
