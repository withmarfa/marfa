//! Move evidence for a sender that checks after the receiver has released the file.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::state;
use crate::CoreError;
use crate::store::{meta_delete, meta_get, meta_set, meta_under};

const TRAIL: &str = "folder_trail:";

pub(super) const PER_ITEM: usize = 8;
/// Pruning leaves room for new arrivals.
pub(super) const ITEMS: usize = 2048;
const ITEMS_AFTER_PRUNE: usize = ITEMS * 3 / 4;
pub(super) const KEPT_FOR_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A file of the item that arrived here or that this folder let go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Step {
    /// Source store, when known. A let-go has no source store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub identity: Option<String>,
    pub hash: String,
    pub at: i64,
}

impl Step {
    fn is(&self, lost: &state::Bound, own: Option<&str>) -> bool {
        match (&self.identity, &lost.identity) {
            (Some(step), Some(lost)) => step == lost,
            _ => {
                self.from.is_some() && self.from.as_deref() == own && self.hash == lost.content_hash
            }
        }
    }
}

fn key(item_id: &str) -> String {
    format!("{TRAIL}{item_id}")
}

fn fresh(steps: Vec<Step>, now: i64) -> Vec<Step> {
    steps
        .into_iter()
        .filter(|step| now - step.at <= KEPT_FOR_MS)
        .collect()
}

fn read(conn: &Connection, item_id: &str) -> Result<Vec<Step>, CoreError> {
    Ok(meta_get(conn, &key(item_id))?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

/// The item's steps that still show a move at `now`.
pub(super) fn steps(conn: &Connection, item_id: &str, now: i64) -> Result<Vec<Step>, CoreError> {
    Ok(fresh(read(conn, item_id)?, now))
}

pub(super) fn shows(steps: &[Step], lost: &state::Bound, own: Option<&str>) -> bool {
    steps.iter().any(|step| step.is(lost, own))
}

/// Pruning and insertion must succeed together.
pub(super) fn record(conn: &Connection, item_id: &str, step: Step) -> Result<(), CoreError> {
    conn.execute_batch("SAVEPOINT folder_trail")?;
    let kept = keep(conn, item_id, step);
    let end = if kept.is_ok() {
        "RELEASE folder_trail"
    } else {
        "ROLLBACK TO folder_trail; RELEASE folder_trail"
    };
    conn.execute_batch(end)?;
    kept
}

fn keep(conn: &Connection, item_id: &str, step: Step) -> Result<(), CoreError> {
    let now = step.at;
    let mut steps = fresh(read(conn, item_id)?, now);
    let new = steps.is_empty();
    steps.insert(0, step);
    steps.sort_by_key(|step| std::cmp::Reverse(step.at));
    steps.truncate(PER_ITEM);
    let json =
        serde_json::to_string(&steps).map_err(|error| CoreError::Store(error.to_string()))?;
    meta_set(conn, &key(item_id), &json)?;
    if new {
        prune(conn, now)?;
    }
    Ok(())
}

/// Keep the most recently active items when the trail exceeds its limit.
fn prune(conn: &Connection, now: i64) -> Result<(), CoreError> {
    let count: i64 = conn
        .prepare_cached("SELECT count(*) FROM meta WHERE key >= ?1 AND key < ?2")?
        .query_row(
            rusqlite::params![TRAIL, crate::store::prefix_end(TRAIL)],
            |row| row.get(0),
        )?;
    if count <= ITEMS as i64 {
        return Ok(());
    }
    let mut newest: Vec<(i64, String)> = Vec::new();
    for (item_id, json) in meta_under(conn, TRAIL)? {
        let steps: Vec<Step> = serde_json::from_str(&json).unwrap_or_default();
        match fresh(steps, now).iter().map(|step| step.at).max() {
            Some(at) => newest.push((at, item_id)),
            None => meta_delete(conn, &key(&item_id))?,
        }
    }
    newest.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    for (_, item_id) in newest.iter().skip(ITEMS_AFTER_PRUNE) {
        meta_delete(conn, &key(item_id))?;
    }
    Ok(())
}

pub(super) fn forget(conn: &Connection, item_id: &str) -> Result<(), CoreError> {
    meta_delete(conn, &key(item_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        crate::store::testing::conn()
    }

    fn step(identity: &str, at: i64) -> Step {
        Step {
            from: Some("a".into()),
            identity: Some(identity.into()),
            hash: format!("h-{identity}"),
            at,
        }
    }

    fn lost(identity: Option<&str>, hash: &str) -> state::Bound {
        state::Bound {
            path: "Plan.md".into(),
            item_id: "plan".into(),
            identity: identity.map(str::to_string),
            content_hash: hash.into(),
            presentation: None,
            blob: None,
            written_hash: None,
            links: Vec::new(),
            embeds: Vec::new(),
            lines: Vec::new(),
            edit_line: None,
            held: None,
            own: None,
            writes: state::Writes::default(),
        }
    }

    #[test]
    fn an_item_keeps_its_newest_steps_only() {
        let conn = conn();
        for at in 0..(PER_ITEM as i64 + 3) {
            record(&conn, "plan", step(&format!("i{at}"), at)).unwrap();
        }
        let kept = steps(&conn, "plan", PER_ITEM as i64 + 3).unwrap();
        assert_eq!(kept.len(), PER_ITEM);
        assert_eq!(kept[0].at, PER_ITEM as i64 + 2);
        assert_eq!(kept[PER_ITEM - 1].at, 3);
        // The witness: the newest step still shows its file.
        assert!(shows(&kept, &lost(Some("i10"), "x"), None));
        assert!(!shows(&kept, &lost(Some("i0"), "x"), None));
    }

    #[test]
    fn a_step_past_its_age_shows_no_move_and_is_dropped() {
        let conn = conn();
        record(&conn, "plan", step("old", 0)).unwrap();
        assert!(shows(
            &steps(&conn, "plan", KEPT_FOR_MS).unwrap(),
            &lost(Some("old"), "x"),
            None
        ));
        assert!(steps(&conn, "plan", KEPT_FOR_MS + 1).unwrap().is_empty());
        record(&conn, "plan", step("new", KEPT_FOR_MS + 1)).unwrap();
        let kept = read(&conn, "plan").unwrap();
        assert_eq!(kept.len(), 1, "a stale step was kept beside a new one");
        assert_eq!(kept[0].identity.as_deref(), Some("new"));
    }

    #[test]
    fn past_the_most_items_those_moved_longest_ago_are_dropped() {
        let conn = conn();
        for at in 0..=(ITEMS as i64) {
            record(&conn, &format!("item{at:05}"), step("i", at)).unwrap();
        }
        let items = meta_under(&conn, TRAIL).unwrap();
        assert_eq!(items.len(), ITEMS_AFTER_PRUNE);
        let oldest_kept = (ITEMS + 1 - ITEMS_AFTER_PRUNE) as i64;
        assert_eq!(
            items.first().map(|(item, _)| item.as_str()),
            Some(format!("item{oldest_kept:05}").as_str())
        );
        assert!(read(&conn, "item00000").unwrap().is_empty());
        assert!(
            !read(&conn, &format!("item{:05}", ITEMS))
                .unwrap()
                .is_empty()
        );
        // At the most and not past it, nothing is dropped.
        let conn = super::tests::conn();
        for at in 0..(ITEMS as i64) {
            record(&conn, &format!("item{at:05}"), step("i", at)).unwrap();
        }
        assert_eq!(meta_under(&conn, TRAIL).unwrap().len(), ITEMS);
    }

    #[test]
    fn a_step_is_the_same_file_by_identity_or_by_its_folders_bytes() {
        let arrived = Step {
            from: Some("a".into()),
            identity: Some("i".into()),
            hash: "h".into(),
            at: 0,
        };
        assert!(arrived.is(&lost(Some("i"), "other"), Some("a")));
        assert!(arrived.is(&lost(Some("i"), "other"), Some("b")));
        // Another file of the item, though it has the same bytes.
        assert!(!arrived.is(&lost(Some("j"), "h"), Some("a")));
        // With no identity, only the bytes the folder it came from bound.
        assert!(arrived.is(&lost(None, "h"), Some("a")));
        assert!(!arrived.is(&lost(None, "h"), Some("b")));
        assert!(!arrived.is(&lost(None, "other"), Some("a")));
        let let_go = Step {
            from: None,
            ..arrived
        };
        assert!(let_go.is(&lost(Some("i"), "x"), Some("a")));
        assert!(!let_go.is(&lost(None, "h"), None));
    }
}
