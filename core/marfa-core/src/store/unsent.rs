//! The writes in the queue: the ones a replaced or removed store would lose, and which of them a folder waits on.

use super::forget::forget_answered_inner;
use super::open::held_shape;
use crate::error::CoreError;
use crate::model::{Verdict, WriteKind};
use rusqlite::Connection;
use std::collections::HashSet;

/// The writes the server has not taken whose kind this build does not send,
/// which only an earlier build's queue can hold, named by kind. Empty where
/// there are none or the queue cannot be read.
pub(super) fn unsendable(conn: &Connection) -> String {
    let held = (|| -> rusqlite::Result<Vec<(String, i64)>> {
        let mut query = conn.prepare(
            "SELECT kind, COUNT(*) FROM queue
              WHERE verdict IS NULL OR verdict NOT IN (?1, ?2, ?3)
              GROUP BY kind ORDER BY kind",
        )?;
        let rows = query.query_map(
            [
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        rows.collect()
    })()
    .unwrap_or_default();
    let named: Vec<String> = held
        .into_iter()
        .filter(|(kind, _)| kind.parse::<WriteKind>().is_err())
        .map(|(kind, count)| {
            format!(
                "{count} {} of kind {kind}",
                if count == 1 { "write" } else { "writes" }
            )
        })
        .collect();
    if named.is_empty() {
        return String::new();
    }
    format!(
        ", and its queue holds {}, which this build cannot send",
        named.join(" and ")
    )
}

/// The id of every write the queue holds.
pub fn queued_ids(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare("SELECT id FROM queue")?;
    let ids = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// Every write the server has not taken that clearing answered writes would
/// keep: waiting, blocked, refused or dead. Read by clearing a copy of the
/// queue in the connection's own temporary space, so the count is what
/// `forget_answered` keeps and a reading connection can take it too. A
/// folder's store also counts each answered write the queue still holds that
/// a file's state waits on, which a store without the queue would leave
/// waiting for ever. `None` where a queue or a folder's record of another
/// shape cannot be counted.
pub(crate) fn untaken_count(conn: &Connection) -> Option<u64> {
    untaken(conn).map(|writes| writes.len() as u64)
}

/// Raw strings preserve kinds and verdicts this build does not recognize.
pub(crate) fn untaken(conn: &Connection) -> Option<Vec<crate::UnsentWrite>> {
    let read = (|| -> Result<Vec<crate::UnsentWrite>, CoreError> {
        conn.execute_batch("CREATE TEMP TABLE queue AS SELECT * FROM main.queue")?;
        forget_answered_inner(conn, None, None, false)?;
        let mut query = conn.prepare(
            "SELECT id, kind, item_id, payload, verdict FROM temp.queue
              WHERE verdict IS NULL OR verdict NOT IN (?1, ?2, ?3)
              ORDER BY seq",
        )?;
        let rows = query.query_map(
            [
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| {
                Ok(crate::UnsentWrite {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    item_id: row.get(2)?,
                    body: row.get(3)?,
                    verdict: row.get(4)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })();
    let _ = conn.execute_batch("DROP TABLE IF EXISTS temp.queue");
    read.ok()
}

/// The writes a replacement of a folder's store would lose: each not yet
/// sent, as a folder's removal counts them; each refused or dead one but a
/// refusal the folder has dealt with; and each answered one a file's state
/// still waits on.
#[cfg(unix)]
pub(super) fn folder_unsent(conn: &Connection) -> Option<u64> {
    let counted = (|| -> Result<usize, CoreError> {
        let mut unsent =
            conn.prepare("SELECT id FROM main.queue WHERE verdict IS NULL OR verdict = ?1")?;
        let mut held: HashSet<String> = unsent
            .query_map([Verdict::Blocked.as_str()], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        held.extend(unrecorded_answers(conn)?);
        held.extend(awaited_by_files(conn)?);
        Ok(held.len())
    })();
    counted.ok().and_then(|count| u64::try_from(count).ok())
}

/// The refused and dead writes in the queue that the folder has not dealt
/// with, by id. A dead write may yet have landed, and only its own build can
/// release it. A refusal of a change the folder records against a file, to
/// an item a file is bound to (either end, for an edge), the folder has
/// recorded against that file, or has cleared from it once a later save was
/// taken; one it has yet to record is still on the file's waiting list, which
/// `awaited_by_files` counts. That also takes in a placement or a default
/// edge of a bound item, which no file records: each asks only for what the
/// file's path or the folder's settings say, and the replacement keeps both.
/// A refusal of any other kind no file records.
#[cfg(unix)]
fn unrecorded_answers(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let recorded_against_files = [
        WriteKind::UpdateItem,
        WriteKind::AddTag,
        WriteKind::RemoveTag,
        WriteKind::TransitionItem,
        WriteKind::CreateEdge,
        WriteKind::DeleteEdge,
        WriteKind::UpdateEdge,
    ]
    .map(WriteKind::as_str);
    let bound: HashSet<String> = if held_shape(conn)?.contains_key("folder_files") {
        let mut statement = conn.prepare("SELECT item_id FROM main.folder_files")?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    } else {
        HashSet::new()
    };
    let is_bound = |item: &Option<String>| item.as_ref().is_some_and(|item| bound.contains(item));
    // A queue of another shape may not hold an edge's to end under this
    // build's name: its refusals are then judged by the from end alone.
    let to_end = if queue_holds(conn, "to_id")? {
        "to_id"
    } else {
        "NULL"
    };
    let mut statement = conn.prepare(&format!(
        "SELECT id, kind, item_id, {to_end}, verdict, reason
           FROM main.queue WHERE verdict IN (?1, ?2)"
    ))?;
    let mut unrecorded = HashSet::new();
    let mut rows = statement.query([Verdict::Refused.as_str(), Verdict::Dead.as_str()])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(1)?;
        let (item, to): (Option<String>, Option<String>) = (row.get(2)?, row.get(3)?);
        let refused = row.get::<_, String>(4)? == Verdict::Refused.as_str();
        // A delete of an edge refused as already gone did what it asked.
        let done = kind == WriteKind::DeleteEdge.as_str()
            && row.get::<_, Option<String>>(5)?.as_deref() == Some("edge_not_found");
        let handled =
            recorded_against_files.contains(&kind.as_str()) && (is_bound(&item) || is_bound(&to));
        if !(refused && (done || handled)) {
            unrecorded.insert(row.get(0)?);
        }
    }
    Ok(unrecorded)
}

#[cfg(unix)]
fn queue_holds(conn: &Connection, column: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('queue', 'main') WHERE name = ?1)",
        [column],
        |row| row.get(0),
    )?)
}

/// The writes in the queue that a folder's file state names as waiting on
/// their answer, by id. A record that is not JSON is read, and refused.
pub(crate) fn awaited_by_files(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = match conn.prepare(
        "SELECT writes FROM main.folder_files
          WHERE NOT json_valid(writes)
             OR json_array_length(writes, '$.queued') > 0
             OR json_array_length(writes, '$.landing.before.writes.queued') > 0",
    ) {
        Ok(statement) => statement,
        // A store with no folder record of this kind records no file.
        Err(error) => {
            let recorded = conn
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM main.folder_files)",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false);
            return if recorded {
                Err(error.into())
            } else {
                Ok(HashSet::new())
            };
        }
    };
    let mut named = HashSet::new();
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let writes: serde_json::Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let landing = &writes["landing"]["before"]["writes"]["queued"];
        for queued in [&writes["queued"], landing] {
            let Some(queued) = queued.as_array() else {
                continue;
            };
            for entry in queued {
                let Some(id) = entry["id"].as_str() else {
                    return Err(CoreError::Store(format!(
                        "a file's waiting write names no id: {entry}"
                    )));
                };
                named.insert(id.to_string());
            }
        }
    }
    let mut held = HashSet::new();
    for id in named {
        if queued_in_main(conn, &id)? {
            held.insert(id);
        }
    }
    Ok(held)
}

fn queued_in_main(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM main.queue WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?)
}
