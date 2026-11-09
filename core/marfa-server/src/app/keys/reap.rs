//! A key revoked or expired stays a while, so that a request bearing it is refused as ended
//! rather than unknown.

use rusqlite::{Transaction, params};

use super::super::clock::readable;
use super::super::refusal::Result;

pub const KEPT_DAYS: i64 = 30;

fn ended() -> String {
    format!(
        "(({} AND revoked_at < ?1) OR (revoked_at IS NULL AND {} AND expires_at < ?1))",
        readable("revoked_at"),
        readable("expires_at")
    )
}

pub fn any(tx: &Transaction<'_>, before: &str) -> Result<bool> {
    Ok(tx.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM api_keys WHERE {})", ended()),
        [before],
        |row| row.get(0),
    )?)
}

pub fn remove(tx: &Transaction<'_>, before: &str, limit: i64) -> Result<i64> {
    let chosen = format!(
        "SELECT id FROM api_keys WHERE {} ORDER BY id LIMIT ?2",
        ended()
    );
    tx.execute(
        &format!("DELETE FROM api_key_sources WHERE key_id IN ({chosen})"),
        params![before, limit],
    )?;
    let removed = tx.execute(
        &format!("DELETE FROM api_keys WHERE id IN ({chosen})"),
        params![before, limit],
    )?;
    Ok(removed as i64)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{keyed, keys};
    use super::*;
    use crate::app::clock::Stamp;

    const NOW: i64 = 1_800_000_000_000;

    fn at(ms: i64) -> String {
        Stamp::from_ms(ms).unwrap().text()
    }

    #[test]
    fn takes_only_keys_whose_end_it_reads() {
        let mut db = keys();
        let tx = db.transaction().unwrap();
        let past = at(NOW - 1);
        keyed(&tx, "expired", Some(&past), None);
        keyed(&tx, "revoked", None, Some(&past));
        keyed(&tx, "live", Some(&at(NOW + 1)), None);
        for stored in ["0", "z", "soon"] {
            keyed(&tx, &format!("expired {stored}"), Some(stored), None);
            keyed(&tx, &format!("revoked {stored}"), None, Some(stored));
        }
        let before = at(NOW);
        assert!(any(&tx, &before).unwrap());
        assert_eq!(remove(&tx, &before, 100).unwrap(), 2);
        assert!(!any(&tx, &before).unwrap());
        let left: i64 = tx
            .query_row("SELECT count(*) FROM api_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 7);
    }
}
