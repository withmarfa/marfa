//! The `enrichment_files` table: which file items wait to be read, and what became of each.

use rusqlite::{Transaction, params};

use crate::app::refusal::Result;

/// Why a file was left, which decides what brings it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    Unsupported,
    Encrypted,
    OverLimit,
    Ocr,
}

impl Why {
    fn word(self) -> &'static str {
        match self {
            Why::Unsupported => "unsupported",
            Why::Encrypted => "encrypted",
            Why::OverLimit => "over_limit",
            Why::Ocr => "ocr",
        }
    }
}

/// The settings each kind of skip depends on, as they stand now.
#[derive(Clone, Debug)]
pub struct Signatures {
    pub native: String,
    pub limits: String,
    pub ocr: String,
}

impl Signatures {
    pub fn of(&self, why: Why) -> &str {
        match why {
            Why::Unsupported => &self.native,
            Why::Encrypted => "",
            Why::OverLimit => &self.limits,
            Why::Ocr => &self.ocr,
        }
    }
}

const BACK: &str = "state = 'skipped' AND ((reason = 'unsupported' AND signature <> ?1) \
     OR (reason = 'over_limit' AND signature <> ?2) OR (reason = 'ocr' AND signature <> ?3))";

/// Whether a run has anything to do: a file waiting, or a skip the settings now reverse.
pub fn due(tx: &Transaction<'_>, max_attempts: i64, signatures: &Signatures) -> Result<bool> {
    Ok(tx
        .prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM enrichment_files \
             WHERE (state = 'waiting' AND attempts < ?4) OR ({BACK}))"
        ))?
        .query_row(
            params![
                signatures.native,
                signatures.limits,
                signatures.ocr,
                max_attempts
            ],
            |row| row.get(0),
        )?)
}

/// Offers again the files a change of settings may let be read.
pub fn requeue(tx: &Transaction<'_>, signatures: &Signatures) -> Result<()> {
    tx.prepare_cached(&format!(
        "UPDATE enrichment_files SET state = 'waiting', attempts = 0, reason = NULL, \
         signature = '' WHERE {BACK}"
    ))?
    .execute(params![
        signatures.native,
        signatures.limits,
        signatures.ocr
    ])?;
    Ok(())
}

/// The files to read next, longest waiting first, leaving the bin's alone.
pub fn next(tx: &Transaction<'_>, max_attempts: i64, limit: i64) -> Result<Vec<(i64, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT f.item_seq, f.hash FROM enrichment_files f \
         JOIN items i ON i.seq = f.item_seq \
         WHERE f.state = 'waiting' AND f.attempts < ?1 AND i.state <> 'trashed' \
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

/// A file that was not tried is not counted against.
pub fn refund(tx: &Transaction<'_>, seq: i64, hash: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET attempts = max(attempts - 1, 0) \
         WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash])?;
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
         updated_at = ?3 WHERE item_seq = ?1 AND hash = ?2",
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
    tx.prepare_cached(
        "UPDATE enrichment_files SET state = 'skipped', reason = ?3, signature = ?4, \
         updated_at = ?5 WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, why.word(), signature, at])?;
    Ok(())
}

/// Moves a file that failed to the back of the line.
pub fn failed(tx: &Transaction<'_>, seq: i64, hash: &str, at: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE enrichment_files SET updated_at = ?3 WHERE item_seq = ?1 AND hash = ?2",
    )?
    .execute(params![seq, hash, at])?;
    Ok(())
}
