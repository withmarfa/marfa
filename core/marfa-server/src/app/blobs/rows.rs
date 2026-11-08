//! The only SQL of the blob tables.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, Transaction, params, params_from_iter};

use super::Blob;
use super::hash::Hash;
use super::references::Row;
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

pub fn register_disk(tx: &Transaction<'_>, id: &str, locator: &str, at: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO stores (id, kind, locator, attached_at) VALUES (?1, 'disk', ?2, ?3) \
         ON CONFLICT (id) DO UPDATE SET locator = excluded.locator, detached_at = NULL",
        params![id, locator, at],
    )?;
    Ok(())
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

/// Whether the copy record holds a copy of the blob in an attached store.
pub fn held_in(tx: &Transaction<'_>, hash: &Hash, store_id: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM blob_copies c JOIN stores s ON s.id = c.store_id \
         WHERE c.hash = ?1 AND c.store_id = ?2 AND s.detached_at IS NULL)",
        params![hash.as_str(), store_id],
        |row| row.get(0),
    )?)
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
}
