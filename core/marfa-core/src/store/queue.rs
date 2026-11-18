//! The write queue: adding a write, finding the write ahead of it and reading what waits.

use super::dead::remaining_dead_fields;
use super::reads::{edge_by_id, item_by_id};
use super::time::now_iso;
use super::verdicts::{payload_of, pending_landing};
use crate::error::CoreError;
use crate::model::{BlockedReason, Item, QueuedWrite, Subject, Verdict, WriteKind};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

pub(super) const QUEUE_COLUMNS: &str = "id, kind, item_id, to_id, edge_id, namespace, tag, \
     base_version, idempotency_key, depends_on, verdict, reason, answer, \
     conflicted_copy_id, refusals, queued_at, answered_at, blob, follows, payload, \
     environmental_streak, last_failure, row_table, batched_with, conflicts";

pub struct NewWrite<'a> {
    pub kind: WriteKind,
    pub item_id: Option<&'a str>,
    pub to_id: Option<&'a str>,
    pub edge_id: Option<&'a str>,
    pub namespace: Option<&'a str>,
    pub tag: Option<&'a str>,
    pub blob: Option<&'a str>,
    pub base_version: Option<i64>,
    pub payload: &'a str,
    pub depends_on: &'a [String],
}

/// Refuses a body the server would refuse for its nesting
/// (`items/json-depth`), and that a later read of the queue could not parse.
/// One pass over the text, with no tree, so it also bounds a hostile value.
fn refuse_too_deep(payload: &str) -> Result<(), CoreError> {
    let (mut depth, mut in_string, mut escaped) = (0usize, false, false);
    for byte in payload.bytes() {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                if depth > crate::MAX_JSON_DEPTH {
                    return Err(CoreError::Invalid(format!(
                        "a write nests its JSON deeper than {} levels, counting the write's own",
                        crate::MAX_JSON_DEPTH
                    )));
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

/// The idempotency key is minted here, not at send: a key minted per send
/// would let a retry of a write whose answer was lost write it twice.
pub fn enqueue(conn: &Connection, write: &NewWrite<'_>) -> Result<QueuedWrite, CoreError> {
    refuse_too_deep(write.payload)?;
    if let Some(item) = write.item_id {
        super::removing::refuse_removing(conn, item)?;
    }
    let id = Uuid::now_v7().to_string();
    let key = Uuid::now_v7().to_string();
    let depends_on = if write.depends_on.is_empty() {
        None
    } else {
        Some(serde_json::to_string(write.depends_on)?)
    };
    let follows = write_ahead(conn, write)?;
    conn.execute(
        "INSERT INTO queue (
             id, kind, item_id, to_id, edge_id, namespace, tag, blob,
             base_version, idempotency_key, payload, depends_on, queued_at,
             follows
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            write.kind.as_str(),
            write.item_id,
            write.to_id,
            write.edge_id,
            write.namespace,
            write.tag,
            write.blob,
            write.base_version,
            key,
            write.payload,
            depends_on,
            now_iso(),
            follows,
        ],
    )?;
    queued_write(conn, &id)?.ok_or_else(|| CoreError::Store("the queued write vanished".into()))
}

fn write_ahead(conn: &Connection, write: &NewWrite<'_>) -> Result<Option<String>, CoreError> {
    let Some(subject) = write.kind.subject() else {
        return Ok(None);
    };
    let named = match subject {
        Subject::Item => write.item_id,
        Subject::Edge => write.edge_id,
    };
    let Some(named) = named else {
        return Ok(None);
    };
    let direct = last_write_to(conn, subject, named)?;
    if subject != Subject::Item {
        return Ok(direct);
    }
    // A create carrying this row's natural key lands on this row, so it is a
    // write to it too.
    let keyed: Option<(String, i64)> = conn
        .query_row(
            "SELECT queue.id, queue.seq FROM queue, items
              WHERE items.id = ?1 AND items.source_id IS NOT NULL
                AND queue.kind = ?2 AND queue.item_id != ?1
                AND json_extract(queue.payload, '$.source') = items.source
                AND json_extract(queue.payload, '$.source_id') = items.source_id
                AND (queue.verdict IS NULL OR queue.verdict NOT IN (?3, ?4, ?5))
              ORDER BY queue.seq DESC LIMIT 1",
            params![
                named,
                WriteKind::CreateItem.as_str(),
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str()
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((keyed, keyed_seq)) = keyed else {
        return Ok(direct);
    };
    let direct_seq: Option<i64> = match &direct {
        Some(id) => conn
            .query_row("SELECT seq FROM queue WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?,
        None => None,
    };
    Ok(if direct_seq.is_some_and(|seq| seq > keyed_seq) {
        direct
    } else {
        Some(keyed)
    })
}

/// The last write queued to `named` that the server has not written. A
/// refused one counts: one the drain refused unsent can still be released.
pub fn last_write_to(
    conn: &Connection,
    subject: Subject,
    named: &str,
) -> Result<Option<String>, CoreError> {
    let kinds = subject.kinds();
    let places = vec!["?"; kinds.len()].join(", ");
    Ok(conn
        .query_row(
            &format!(
                "SELECT id FROM queue
                  WHERE {column} = ? AND kind IN ({places})
                    AND (verdict IS NULL OR verdict NOT IN (?, ?, ?))
                  ORDER BY seq DESC LIMIT 1",
                column = subject.column()
            ),
            params_from_iter(
                std::iter::once(named)
                    .chain(kinds.iter().map(|kind| kind.as_str()))
                    .chain([
                        Verdict::Accepted.as_str(),
                        Verdict::Merged.as_str(),
                        Verdict::Conflicted.as_str(),
                    ]),
            ),
            |row| row.get(0),
        )
        .optional()?)
}

pub fn item_under_key(
    conn: &Connection,
    source: &str,
    source_id: &str,
) -> Result<Option<Item>, CoreError> {
    let id: Option<String> = conn.query_row(
        "SELECT id FROM items WHERE source = ?1 AND source_id = ?2 ORDER BY version DESC, id LIMIT 1",
        params![source, source_id], |row| row.get(0),
    ).optional()?;
    id.map(|id| item_by_id(conn, &id))
        .transpose()
        .map(Option::flatten)
}

/// Orders a create carrying a held row's natural key behind that row's last
/// unwritten write, since the server lands the create on that row.
pub fn follow_row_under_key(
    conn: &Connection,
    create: &QueuedWrite,
    source: &str,
    source_id: &str,
) -> Result<(), CoreError> {
    let held: Option<String> = conn
        .query_row(
            "SELECT id FROM items WHERE source = ?1 AND source_id = ?2 AND id != ?3",
            params![source, source_id, create.item_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(held) = held else {
        return Ok(());
    };
    if let Some(ahead) = last_write_to(conn, Subject::Item, &held)? {
        conn.execute(
            "UPDATE queue SET follows = ?2 WHERE id = ?1",
            params![create.id, ahead],
        )?;
    }
    Ok(())
}

/// Rebuilds `follows` for the writes to `item_id` in queue order, for a row
/// a landed create's writes were just moved onto. `answered` is that create,
/// which orders nothing.
pub fn refollow(conn: &Connection, item_id: &str, answered: &str) -> Result<(), CoreError> {
    let kinds = Subject::Item.kinds();
    let places = vec!["?"; kinds.len()].join(", ");
    let mut statement = conn.prepare(&format!(
        "SELECT id FROM queue
          WHERE item_id = ? AND id != ? AND kind IN ({places})
            AND (verdict IS NULL OR verdict NOT IN (?, ?, ?))
          ORDER BY seq"
    ))?;
    let ids: Vec<String> = statement
        .query_map(
            params_from_iter(
                [item_id, answered]
                    .into_iter()
                    .chain(kinds.iter().map(|kind| kind.as_str()))
                    .chain([
                        Verdict::Accepted.as_str(),
                        Verdict::Merged.as_str(),
                        Verdict::Conflicted.as_str(),
                    ]),
            ),
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?;
    let mut ahead: Option<String> = None;
    for id in ids {
        conn.execute(
            "UPDATE queue SET follows = ?2 WHERE id = ?1",
            params![id, ahead],
        )?;
        ahead = Some(id);
    }
    Ok(())
}

pub fn queued_write(conn: &Connection, id: &str) -> Result<Option<QueuedWrite>, CoreError> {
    Ok(read_writes(conn, "WHERE id = ?1", [id])?.pop())
}

/// A blocked create counts: a write sent past one is refused
/// `item_not_found`, and the reconcile that follows forgets the row.
pub fn untaken_creates_for_item(
    conn: &Connection,
    item_id: &str,
) -> Result<Vec<String>, CoreError> {
    // A create refused onto a row no read has found yet still decides where a
    // later write to its row goes, or whether it goes at all. Looking up each
    // create by key avoids scanning unrelated pending landings.
    let mut waiting = Vec::new();
    for row in read_writes(
        conn,
        "WHERE item_id = ?1 AND kind = ?2",
        [item_id, WriteKind::CreateItem.as_str()],
    )? {
        if matches!(row.verdict, None | Some(Verdict::Blocked | Verdict::Dead))
            || pending_landing(conn, &row.id)?.is_some()
        {
            waiting.push(row.id);
        }
    }
    Ok(waiting)
}

pub fn queued_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(conn, "", [])
}

/// The writes the queue holds of those `ids` names, in queue order, each
/// found through the index on its id.
pub fn queued_writes_named(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<QueuedWrite>, CoreError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let named = serde_json::to_string(ids)
        .map_err(|error| CoreError::Invalid(format!("the ids cannot be named: {error}")))?;
    read_writes(
        conn,
        "WHERE id IN (SELECT value FROM json_each(?1))",
        [named],
    )
}

#[cfg(test)]
thread_local! {
    /// How many queue rows this thread has read, for tests that count them.
    pub(crate) static ROWS_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Reports and projections use the same current attempt's effects. Queue
/// bodies and captured reads remain immutable, including after cleanup.
pub fn current_waiting_writes(
    conn: &Connection,
    queue: &[QueuedWrite],
) -> Result<Vec<QueuedWrite>, CoreError> {
    let mut waiting = Vec::new();
    for row in queue {
        if matches!(row.verdict, None | Some(Verdict::Blocked))
            || row.verdict == Some(Verdict::Dead)
                && remaining_dead_fields(conn, row)?.is_none_or(|fields| !fields.is_empty())
        {
            waiting.push(row.clone());
        }
    }
    Ok(waiting)
}

pub(super) fn current_item_writes(
    conn: &Connection,
    id: &str,
) -> Result<Vec<QueuedWrite>, CoreError> {
    current_waiting_writes(conn, &waiting_writes_for_item(conn, id)?)
}

pub(super) fn current_edge_writes(
    conn: &Connection,
    id: &str,
) -> Result<Vec<QueuedWrite>, CoreError> {
    current_waiting_writes(conn, &waiting_writes_for_edge(conn, id)?)
}

/// Raw unanswered and releasable work, even if its content effects are now
/// covered. Queue lifecycle and recovery guards must still protect it.
pub fn waiting_writes(conn: &Connection) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE verdict IS NULL OR verdict IN (?1, ?2)",
        [Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

/// Whether any write is yet to be sent or answered. A write the server
/// answered, accepted or refused, or one released only by a person, has a
/// verdict.
pub fn has_unanswered_writes(conn: &Connection) -> Result<bool, CoreError> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM queue WHERE verdict IS NULL)",
        [],
        |row| row.get(0),
    )?)
}

/// The items with a create or edit the server has yet to answer: none
/// answered and none dead, since a dead write is not sent again unless it
/// is released.
pub fn items_awaiting_their_write(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT item_id FROM queue
          WHERE kind IN (?1, ?2) AND item_id IS NOT NULL
            AND (verdict IS NULL OR verdict = ?3)",
    )?;
    let items = statement
        .query_map(
            [
                WriteKind::CreateItem.as_str(),
                WriteKind::UpdateItem.as_str(),
                Verdict::Blocked.as_str(),
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(items)
}

/// A keyed create's version-zero row can still name an unseen server target.
/// A natural key added by a later edit does not change a plain create's origin.
pub fn unanswered_keyed_create(conn: &Connection, item: &Item) -> Result<bool, CoreError> {
    if item.version != 0 {
        return Ok(false);
    }
    Ok(waiting_writes_for_item(conn, &item.id)?
        .iter()
        .any(|write| {
            write.kind == WriteKind::CreateItem
                && write
                    .body
                    .get("source_id")
                    .and_then(Value::as_str)
                    .is_some()
        }))
}

/// Whether a write to the row itself waits, not an edge from it.
pub(super) fn row_writes_wait(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(waiting_writes_for_item(conn, id)?
        .iter()
        .any(|row| row.kind.subject() == Some(Subject::Item)))
}

pub fn item_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_item(conn, id)?.is_empty())
}

/// Raw waiting work through the index, including covered Dead rows that
/// remain releasable. Projection must explicitly request current effects.
pub fn waiting_writes_for_item(conn: &Connection, id: &str) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE item_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [id, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

pub fn edge_write_waits(conn: &Connection, id: &str) -> Result<bool, CoreError> {
    Ok(!waiting_writes_for_edge(conn, id)?.is_empty())
}

pub(super) fn waiting_writes_for_edge(
    conn: &Connection,
    id: &str,
) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE edge_id = ?1 AND (verdict IS NULL OR verdict IN (?2, ?3))",
        [id, Verdict::Blocked.as_str(), Verdict::Dead.as_str()],
    )
}

/// Waiting writes queued under another item that reach row `id`: a create
/// under its natural key, or a move of an edge to start from it. A create
/// that names no source counts, since it goes under its credential's source,
/// which may be the row's.
pub fn waiting_writes_reaching_item(
    conn: &Connection,
    id: &str,
) -> Result<Vec<QueuedWrite>, CoreError> {
    read_writes(
        conn,
        "WHERE item_id != ?1 AND (verdict IS NULL OR verdict IN (?4, ?5))
           AND ((kind = ?2 AND EXISTS (SELECT 1 FROM items
                   WHERE items.id = ?1 AND items.source_id IS NOT NULL
                     AND json_extract(queue.payload, '$.source_id') = items.source_id
                     AND coalesce(json_extract(queue.payload, '$.source') = items.source, 1)))
             OR (kind = ?3 AND json_extract(queue.payload, '$.from_id') = ?1))",
        params![
            id,
            WriteKind::CreateItem.as_str(),
            WriteKind::UpdateEdge.as_str(),
            Verdict::Blocked.as_str(),
            Verdict::Dead.as_str()
        ],
    )
}

/// The rows other than its own item that `write` reaches, on the rule
/// `waiting_writes_reaching_item` counts by.
pub(crate) fn rows_reached_by(
    conn: &Connection,
    write: &QueuedWrite,
) -> Result<Vec<String>, CoreError> {
    match write.kind {
        WriteKind::CreateItem => {
            let Some(source_id) = write.body.get("source_id").and_then(Value::as_str) else {
                return Ok(Vec::new());
            };
            let source = write.body.get("source").and_then(Value::as_str);
            rows_under_key(conn, source_id, source, write.item_id.as_deref())
        }
        WriteKind::UpdateEdge => Ok(write
            .body
            .get("from_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .into_iter()
            .collect()),
        _ => Ok(Vec::new()),
    }
}

/// The rows other than `except` that a create naming `source_id` lands on:
/// under `source`, or under any source where it is not known.
pub(crate) fn rows_under_key(
    conn: &Connection,
    source_id: &str,
    source: Option<&str>,
    except: Option<&str>,
) -> Result<Vec<String>, CoreError> {
    let mut statement = conn.prepare_cached(
        "SELECT id FROM items
          WHERE source_id = ?1 AND id IS NOT ?2 AND coalesce(source = ?3, 1)",
    )?;
    let rows = statement
        .query_map(params![source_id, except, source], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub(crate) fn read_writes(
    conn: &Connection,
    filter: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<QueuedWrite>, CoreError> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT {QUEUE_COLUMNS} FROM queue {filter} ORDER BY seq ASC"
    ))?;
    // Positional, in `QUEUE_COLUMNS` order: two columns of the same type
    // swapped here would read as valid data.
    //
    // Unreadable dependencies are a refusal, not none: none would tell a
    // drain that nothing holds the write.
    let rows = statement.query_map(values, |row| {
        Ok(RawWrite {
            id: row.get(0)?,
            kind: row.get(1)?,
            item_id: row.get(2)?,
            to_id: row.get(3)?,
            edge_id: row.get(4)?,
            namespace: row.get(5)?,
            tag: row.get(6)?,
            base_version: row.get(7)?,
            idempotency_key: row.get(8)?,
            depends_on: row.get(9)?,
            verdict: row.get(10)?,
            reason: row.get(11)?,
            answer: row.get(12)?,
            conflicted_copy_id: row.get(13)?,
            refusals: row.get(14)?,
            queued_at: row.get(15)?,
            answered_at: row.get(16)?,
            blob: row.get(17)?,
            follows: row.get(18)?,
            payload: row.get(19)?,
            environmental_streak: row.get(20)?,
            last_failure: row.get(21)?,
            row_table: row.get(22)?,
            batched_with: row.get(23)?,
            conflicts: row.get(24)?,
        })
    })?;

    let mut writes = Vec::new();
    for row in rows {
        let raw = row?;
        #[cfg(test)]
        ROWS_READ.with(|read| read.set(read.get() + 1));
        let depends_on = match raw.depends_on {
            Some(json) => serde_json::from_str(&json).map_err(|error| {
                CoreError::Store(format!(
                    "queued write {} holds dependencies this build cannot read ({error}); \
                     the store was written by another build and has no upgrade path",
                    raw.id
                ))
            })?,
            None => Vec::new(),
        };
        let verdict = raw
            .verdict
            .as_deref()
            .map(str::parse::<Verdict>)
            .transpose()?;
        if verdict == Some(Verdict::Blocked)
            && raw.reason.as_deref() != Some(crate::model::AWAITING_DEPENDENCY)
        {
            raw.reason
                .as_deref()
                .unwrap_or_default()
                .parse::<BlockedReason>()
                .map_err(|_| {
                    CoreError::Store(format!(
                        "queued write {} is blocked for a reason outside the six a caller can name: {:?}",
                        raw.id, raw.reason
                    ))
                })?;
        }
        let body = serde_json::from_str(&raw.payload).map_err(|error| {
            CoreError::Store(format!(
                "queued write {} carries a body this build cannot read ({error})",
                raw.id
            ))
        })?;
        let refusal =
            crate::model::Refusal::for_write(verdict, raw.reason.as_deref(), raw.answer.as_deref());
        let last_failure = raw
            .last_failure
            .as_deref()
            .map(|json| {
                serde_json::from_str(json).map_err(|error| {
                    CoreError::Store(format!(
                        "queued write {} holds a last failure this build cannot read ({error})",
                        raw.id
                    ))
                })
            })
            .transpose()?;
        let conflicts = match raw.conflicts.as_deref() {
            Some(json) => serde_json::from_str(json).map_err(|error| {
                CoreError::Store(format!(
                    "queued write {} holds conflicts this build cannot read ({error})",
                    raw.id
                ))
            })?,
            None => Vec::new(),
        };
        writes.push(QueuedWrite {
            kind: raw.kind.parse()?,
            id: raw.id,
            item_id: raw.item_id,
            to_id: raw.to_id,
            edge_id: raw.edge_id,
            namespace: raw.namespace,
            tag: raw.tag,
            blob: raw.blob,
            base_version: raw.base_version,
            idempotency_key: raw.idempotency_key,
            depends_on,
            follows: raw.follows,
            verdict,
            reason: raw.reason,
            answer: raw.answer,
            environmental_streak: raw.environmental_streak,
            last_failure,
            refusal,
            body,
            conflicted_copy_id: raw.conflicted_copy_id,
            refusals: raw.refusals,
            table: raw.row_table,
            batched_with: raw.batched_with,
            conflicts,
            queued_at: raw.queued_at,
            answered_at: raw.answered_at,
        });
    }
    Ok(writes)
}

struct RawWrite {
    id: String,
    kind: String,
    item_id: Option<String>,
    to_id: Option<String>,
    edge_id: Option<String>,
    namespace: Option<String>,
    tag: Option<String>,
    blob: Option<String>,
    base_version: Option<i64>,
    idempotency_key: String,
    depends_on: Option<String>,
    verdict: Option<String>,
    reason: Option<String>,
    answer: Option<String>,
    conflicted_copy_id: Option<String>,
    refusals: i64,
    queued_at: String,
    answered_at: Option<String>,
    follows: Option<String>,
    payload: String,
    environmental_streak: i64,
    last_failure: Option<String>,
    row_table: Option<String>,
    batched_with: Option<String>,
    conflicts: Option<String>,
}

/// The only write an edit or a delete of the edge cannot go without; the
/// writes ahead of one only order it. That is the waiting create that makes
/// the edge `edge_id`: its own create, or the create of an item shown drawn
/// with it under an id the copy made.
pub fn untaken_create_for_edge(conn: &Connection, edge_id: &str) -> Result<Vec<String>, CoreError> {
    let mut creates: Vec<String> = waiting_writes_for_edge(conn, edge_id)?
        .into_iter()
        .filter(|row| row.kind == WriteKind::CreateEdge)
        .map(|row| row.id)
        .collect();
    if let Some(edge) = edge_by_id(conn, edge_id)? {
        for create in untaken_creates_for_item(conn, &edge.from_id)? {
            let draft = crate::model::Draft::from_payload(&payload_of(conn, &create)?)?;
            if draft.edge_pairs().iter().any(|(edge_type, target)| {
                crate::model::projected_edge_id(&edge.from_id, edge_type, target) == edge_id
            }) {
                creates.push(create);
            }
        }
    }
    Ok(creates)
}
