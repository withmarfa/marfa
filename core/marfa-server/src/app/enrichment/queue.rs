//! The `enrichment_files` table: which file items wait to be read, and what became of each.

use rusqlite::{Transaction, params};

use crate::app::refusal::Result;

/// The limit that stopped a file, with its value then. Only raising that limit brings the file back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cap {
    Blob(u64),
    Inflated(u64),
    Memory(u64),
    /// A bound of the readers, which no setting raises.
    Fixed,
}

impl Cap {
    fn stored(self) -> (&'static str, i64) {
        let value = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
        match self {
            Cap::Blob(at) => ("blob", value(at)),
            Cap::Inflated(at) => ("inflated", value(at)),
            Cap::Memory(at) => ("memory", value(at)),
            Cap::Fixed => ("fixed", 0),
        }
    }
}

/// Why a file was left, which decides what brings it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Unsupported,
    Encrypted,
    OverLimit(Cap),
    Ocr,
    /// The store holds no copy of the file's bytes, so there is nothing to read.
    Missing,
}

impl Why {
    fn word(self) -> &'static str {
        match self {
            Why::Unsupported => "unsupported",
            Why::Encrypted => "encrypted",
            Why::OverLimit(_) => "over_limit",
            Why::Ocr => "ocr",
            Why::Missing => "missing",
        }
    }
}

/// The settings each kind of skip depends on, as they stand now.
#[derive(Clone, Debug)]
pub struct Signatures {
    pub native: String,
    pub ocr: String,
    pub blob: u64,
    pub inflated: u64,
    pub memory: u64,
}

impl Signatures {
    pub fn of(&self, why: Why) -> &str {
        match why {
            Why::Unsupported => &self.native,
            Why::Encrypted | Why::OverLimit(_) | Why::Missing => "",
            Why::Ocr => &self.ocr,
        }
    }

    fn bound(&self) -> [rusqlite::types::Value; 5] {
        let value = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
        [
            self.native.clone().into(),
            value(self.blob).into(),
            value(self.inflated).into(),
            value(self.memory).into(),
            self.ocr.clone().into(),
        ]
    }
}

const BACK: &str = "state = 'skipped' AND ((reason = 'unsupported' AND signature <> ?1) \
     OR (reason = 'over_limit' AND capped_at < CASE capped_by WHEN 'blob' THEN ?2 \
         WHEN 'inflated' THEN ?3 WHEN 'memory' THEN ?4 ELSE -1 END) \
     OR (reason = 'ocr' AND signature <> ?5))";

/// Whether a run has anything to do: a file waiting or offered again, or a skip the settings now reverse.
pub fn due(tx: &Transaction<'_>, max_attempts: i64, signatures: &Signatures) -> Result<bool> {
    Ok(tx
        .prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM enrichment_files \
             WHERE ((state = 'waiting' OR refill = 1) AND attempts < ?6) OR ({BACK}))"
        ))?
        .query_row(
            rusqlite::params_from_iter(signatures.bound().into_iter().chain([max_attempts.into()])),
            |row| row.get(0),
        )?)
}

/// Offers again the files a change of settings may let be read.
pub fn requeue(tx: &Transaction<'_>, signatures: &Signatures) -> Result<()> {
    tx.prepare_cached(&format!(
        "UPDATE enrichment_files SET state = 'waiting', attempts = 0, reason = NULL, \
         signature = '', capped_by = NULL, capped_at = NULL, refill = 0 WHERE {BACK}"
    ))?
    .execute(rusqlite::params_from_iter(signatures.bound()))?;
    Ok(())
}

/// The files to read next, longest waiting first, leaving the bin's alone.
pub fn next(tx: &Transaction<'_>, max_attempts: i64, limit: i64) -> Result<Vec<(i64, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT f.item_seq, f.hash FROM enrichment_files f \
         JOIN items i ON i.seq = f.item_seq \
         WHERE (f.state = 'waiting' OR f.refill = 1) AND f.attempts < ?1 AND i.state <> 'trashed' \
         ORDER BY f.updated_at, f.item_seq LIMIT ?2",
    )?;
    Ok(statement
        .query_map(params![max_attempts, limit], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Counted before the bytes are read, so that a file that ends the server is remembered.
pub fn attempt(tx: &Transaction<'_>, seq: i64, hash: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET attempts = attempts + 1, updated_at = ?3 \
         WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, at])?;
    Ok(())
}

/// A file that was not tried is not counted against, and goes to the back of the line.
pub fn refund(tx: &Transaction<'_>, seq: i64, hash: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET attempts = max(attempts - 1, 0), updated_at = ?3 \
         WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, at])?;
    Ok(())
}

pub fn drop_row(tx: &Transaction<'_>, seq: i64, hash: &str) -> Result<()> {
    tx.prepare_cached("DELETE FROM enrichment_files WHERE item_seq = ?1 AND hash = ?2")?
        .execute(params![seq, hash])?;
    Ok(())
}

pub fn read(tx: &Transaction<'_>, seq: i64, hash: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET state = 'read', reason = NULL, signature = '', \
         capped_by = NULL, capped_at = NULL, refill = 0, updated_at = ?3 \
         WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, at])?;
    Ok(())
}

pub fn skip(
    tx: &Transaction<'_>,
    seq: i64,
    hash: &str,
    why: Why,
    signature: &str,
    at: &str,
) -> Result<()> {
    let (capped_by, capped_at) = match why {
        Why::OverLimit(cap) => {
            let (by, at) = cap.stored();
            (Some(by), Some(at))
        }
        _ => (None, None),
    };
    tx.prepare_cached(
        "UPDATE enrichment_files SET state = 'skipped', reason = ?3, signature = ?4, \
         capped_by = ?5, capped_at = ?6, refill = 0, updated_at = ?7 \
         WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![
        seq,
        hash,
        why.word(),
        signature,
        capped_by,
        capped_at,
        at
    ])?;
    Ok(())
}

/// Moves a file to the back of the line without counting an attempt.
pub fn defer(tx: &Transaction<'_>, seq: i64, hash: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET updated_at = ?3 WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, at])?;
    Ok(())
}
