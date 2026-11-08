//! The only SQL of the blob tables.

use rusqlite::{OptionalExtension, Transaction, params};

use super::Blob;
use super::hash::Hash;
use crate::app::refusal::{Refusal, Result};

/// A row that names a blob through a reference that lends, with the types the read rule asks.
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

pub fn lenders(tx: &Transaction<'_>, hash: &Hash) -> Result<Vec<Lender>> {
    let mut statement = tx.prepare_cached(
        "SELECT 'item', i.type, '' FROM blob_references r JOIN items i ON i.seq = r.seq \
           WHERE r.hash = ?1 AND r.kind = 'item' AND r.lends = 1 \
         UNION ALL \
         SELECT 'edge', e.edge_type, s.type FROM blob_references r \
           JOIN edges e ON e.seq = r.seq JOIN items s ON s.id = e.source_id \
           WHERE r.hash = ?1 AND r.kind = 'edge' AND r.lends = 1 \
         UNION ALL \
         SELECT 'extension', i.type, r.namespace FROM blob_references r \
           JOIN items i ON i.seq = r.seq \
           WHERE r.hash = ?1 AND r.kind = 'extension' AND r.lends = 1",
    )?;
    let rows = statement.query_map([hash.as_str()], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut lenders = Vec::new();
    for row in rows {
        let (kind, first, second) = row?;
        lenders.push(match kind.as_str() {
            "item" => Lender::Item { type_id: first },
            "edge" => Lender::Edge {
                edge_type: first,
                source_type: second,
            },
            "extension" => Lender::Extension {
                namespace: second,
                item_type: first,
            },
            _ => return Err(unread("reference")),
        });
    }
    Ok(lenders)
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
