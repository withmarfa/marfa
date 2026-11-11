//! Which rows name a blob, and whether each reference lends its read.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Transaction;
use serde_json::{Map, Value};

pub use super::digests::digests;
use super::hash::Hash;
use super::rows;
use crate::app::access::Caller;
use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Copy, Debug)]
pub enum Row<'a> {
    Item(i64),
    Edge(i64),
    Extension(i64, &'a str),
    Version(i64, i64),
    /// The owner's picture, the one row that belongs to no item.
    Owner,
}

/// Where the digests a write names came from, beyond the writer.
#[derive(Clone, Copy, Debug, Default)]
pub struct Naming<'a> {
    /// What the version a stale write was made against named: sent back, it proves nothing.
    pub base: Option<&'a BTreeSet<String>>,
    /// The standing each digest had on the row this one copies.
    pub inherited: Option<&'a BTreeMap<String, bool>>,
    /// A file's `blob_ref` written as a whole hash.
    pub bytes: Option<&'a Hash>,
}

/// What a write's properties do to a row's references, decided before the row is written.
#[derive(Debug)]
pub struct Decided {
    held: BTreeMap<String, bool>,
    named: BTreeMap<String, bool>,
}

fn stored(hash: &str) -> Result<Hash> {
    Hash::parse(hash).map_err(|_| Refusal::internal("a digest the index keeps does not read"))
}

/// Refuses the write where it names a file's bytes its writer did not prove.
pub fn decide(
    tx: &Transaction<'_>,
    caller: &Caller,
    row: Option<Row<'_>>,
    properties: &Map<String, Value>,
    naming: Naming<'_>,
) -> Result<Decided> {
    let held = match row {
        Some(row) => rows::references(tx, row)?,
        None => BTreeMap::new(),
    };
    let mut named = BTreeMap::new();
    for digest in digests(properties) {
        let lends = if let Some(lends) = held.get(&digest) {
            *lends
        } else if let Some(lends) = naming.inherited.and_then(|from| from.get(&digest)) {
            *lends
        } else if naming.base.is_some_and(|base| base.contains(&digest)) {
            false
        } else {
            let hash = stored(&digest)?;
            let proved = caller.proves_blob(
                rows::find(tx, &hash)?.is_some(),
                || rows::proved(tx, &digest, &caller.credential_handle()),
                rows::lenders(tx, &hash),
            )?;
            if naming.bytes == Some(&hash) {
                caller.require_file_bytes(proved)?;
            }
            proved
        };
        named.insert(digest, lends);
    }
    Ok(Decided { held, named })
}

/// The standing each digest the row names has now.
pub fn held(tx: &Transaction<'_>, row: Row<'_>) -> Result<BTreeMap<String, bool>> {
    rows::references(tx, row)
}

impl Decided {
    /// The stored length of the bytes `hash` names, where the row's reference to it lends.
    pub fn lent_size(&self, tx: &Transaction<'_>, hash: &Hash) -> Result<Option<u64>> {
        if self.named.get(hash.as_str()) != Some(&true) {
            return Ok(None);
        }
        Ok(rows::find(tx, hash)?.map(|blob| blob.size_bytes))
    }

    pub fn apply(&self, tx: &Transaction<'_>, row: Row<'_>) -> Result<()> {
        for hash in self.held.keys() {
            if !self.named.contains_key(hash) {
                rows::unreference(tx, row, hash)?;
            }
        }
        for (hash, lends) in &self.named {
            if !self.held.contains_key(hash) {
                rows::reference(tx, row, hash, *lends)?;
            }
        }
        Ok(())
    }
}

/// An open job's properties keep every blob they name, and lend no read.
pub fn hold_for_job(tx: &Transaction<'_>, job_id: &str, patch: &Map<String, Value>) -> Result<()> {
    for digest in digests(patch) {
        rows::hold_for_job(tx, job_id, &digest)?;
    }
    Ok(())
}

/// A job that ends keeps nothing.
pub fn release_job(tx: &Transaction<'_>, job_id: &str) -> Result<()> {
    rows::release_job(tx, job_id)
}

/// A row gone takes its references with it.
pub fn forget(tx: &Transaction<'_>, row: Row<'_>) -> Result<()> {
    rows::forget(tx, row)
}

/// An item purged takes its own references, its namespaces' and its versions'.
pub fn forget_item(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    rows::forget_item(tx, seq)
}

/// Asked before the item moves on, so the version it leaves names what the item names.
pub fn keep_version(tx: &Transaction<'_>, seq: i64) -> Result<()> {
    rows::keep_version(tx, seq)
}

/// What a restored row's references are: each digest its properties name lends exactly where
/// its archive line lists it as lending.
pub fn archived(properties: &Map<String, Value>, lending: &BTreeSet<String>) -> Decided {
    let named = digests(properties)
        .into_iter()
        .map(|digest| {
            let lends = lending.contains(&digest);
            (digest, lends)
        })
        .collect();
    Decided {
        held: BTreeMap::new(),
        named,
    }
}
