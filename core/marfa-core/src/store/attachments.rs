//! The files the copy holds attached to its items, the uploads that carry their bytes and the bytes sent again.

use super::meta::{meta_delete, meta_get, meta_set};
use super::verdicts::{Answered, SELF_CLEARING, record_verdict, waits_for_withdrawn};
use crate::error::CoreError;
use crate::model::{Verdict, WriteKind};
use rusqlite::{Connection, named_params, params, params_from_iter};
use std::collections::{HashMap, HashSet};

/// The largest size any file the copy holds states for the bytes `hash`
/// names, or `None` where none states one. Only `core.file` and its subtypes
/// state the size of their bytes, as the server stamps it. A row whose stored
/// properties are not JSON, or whose size is not a whole number above zero,
/// states none.
pub fn stated_size(conn: &Connection, hash: &str) -> Result<Option<u64>, CoreError> {
    let size: Option<i64> = conn.query_row(
        &format!(
            "WITH RECURSIVE {FILE_TYPES}
             SELECT MAX(size) FROM (
               SELECT CASE WHEN json_valid(properties) THEN
                        CASE WHEN json_extract(properties, '$.blob_ref') = ?1
                              AND json_type(properties, '$.size_bytes') = 'integer'
                             THEN json_extract(properties, '$.size_bytes') END
                      END AS size
                 FROM items AS f WHERE {IS_FILE})
             WHERE size > 0"
        ),
        [hash],
        |row| row.get(0),
    )?;
    Ok(size.and_then(|size| u64::try_from(size).ok()))
}

/// `core.file` and every type the catalog sets beneath it, as a common table
/// expression of a `WITH RECURSIVE`; `UNION` ends a cycle of parents.
const FILE_TYPES: &str = "file_types(id) AS (
    SELECT 'core.file'
    UNION SELECT types.id FROM types JOIN file_types ON types.parent = file_types.id)";

/// Whether the item `f` is of a file type, beneath `FILE_TYPES`.
const IS_FILE: &str = "(f.type LIKE 'core.file.%' OR f.type IN (SELECT id FROM file_types))";

/// A file item the copy holds that is attached to an item the copy holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub item_id: String,
    /// The hash its `blob_ref` names, as written there.
    pub hash: String,
    /// The size it states for its bytes, if it states a whole number above
    /// zero.
    pub stated: Option<u64>,
}

/// Every file item the copy holds, out of the bin, that is the from item of an
/// `attached-to` edge whose to item the copy holds out of the bin. A row whose
/// stored properties are not JSON, or that names its bytes by no text, is
/// none.
pub fn attachments(conn: &Connection) -> Result<Vec<Attachment>, CoreError> {
    attachments_where(conn, "1", &[])
}

/// The attachments among `ids` and among the from items of `attached-to` edges
/// to `ids`: those a change to the rows or edges of `ids` can make or end.
fn attachments_touching(conn: &Connection, ids: &[&str]) -> Result<Vec<Attachment>, CoreError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(", ");
    // No `attached-to` edge at `ids` means no attachment, which the edge
    // indexes answer without reading a row.
    let attached: bool = conn
        .prepare_cached(&format!(
            "SELECT EXISTS (SELECT 1 FROM edges WHERE edge_type = '{ATTACHED_TO}' AND from_id IN ({marks}))
                 OR EXISTS (SELECT 1 FROM edges WHERE edge_type = '{ATTACHED_TO}' AND to_id IN ({marks}))"
        ))?
        .query_row(params_from_iter([ids, ids].concat()), |row| row.get(0))?;
    if !attached {
        return Ok(Vec::new());
    }
    attachments_where(
        conn,
        &format!(
            "(f.id IN ({marks}) OR f.id IN (
               SELECT from_id FROM edges
                WHERE edge_type = '{ATTACHED_TO}' AND to_id IN ({marks})))"
        ),
        &[ids, ids].concat(),
    )
}

fn attachments_where(
    conn: &Connection,
    condition: &str,
    values: &[&str],
) -> Result<Vec<Attachment>, CoreError> {
    let sql = format!(
        "WITH RECURSIVE {FILE_TYPES}
         SELECT id, hash, size FROM (
           SELECT f.id AS id,
                  CASE WHEN json_valid(f.properties) THEN
                    CASE WHEN json_type(f.properties, '$.blob_ref') = 'text'
                         THEN json_extract(f.properties, '$.blob_ref') END
                  END AS hash,
                  CASE WHEN json_valid(f.properties) THEN
                    CASE WHEN json_type(f.properties, '$.size_bytes') = 'integer'
                         THEN json_extract(f.properties, '$.size_bytes') END
                  END AS size
             FROM items AS f
            WHERE {IS_FILE} AND f.state != 'trashed'
              AND EXISTS (
                SELECT 1 FROM edges AS e JOIN items AS t ON t.id = e.to_id
                 WHERE e.from_id = f.id AND e.edge_type = '{ATTACHED_TO}'
                   AND t.state != 'trashed')
              AND {condition})
          WHERE hash IS NOT NULL
          ORDER BY id"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let found = statement
        .query_map(params_from_iter(values), |row| {
            Ok(Attachment {
                item_id: row.get(0)?,
                hash: row.get(1)?,
                stated: row
                    .get::<_, Option<i64>>(2)?
                    .and_then(|size| u64::try_from(size).ok())
                    .filter(|size| *size > 0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(found)
}

/// How many from items of `attached-to` edges to items the copy holds out of
/// the bin the copy holds no row of.
pub fn attachments_not_in_copy(conn: &Connection) -> Result<u64, CoreError> {
    let outside: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(DISTINCT e.from_id)
               FROM edges AS e JOIN items AS t ON t.id = e.to_id
              WHERE e.edge_type = '{ATTACHED_TO}' AND t.state != 'trashed'
                AND NOT EXISTS (SELECT 1 FROM items AS f WHERE f.id = e.from_id)"
        ),
        [],
        |row| row.get(0),
    )?;
    Ok(u64::try_from(outside).unwrap_or(0))
}

const ATTACHED_TO: &str = "attached-to";

/// Present from the start of a hydration until one completes: the copy is
/// not whole, so a file whose rows have not arrived again may still be an
/// attachment, and the kept set (`attachment_bytes`) only grows. Not cleared
/// when the copy expires, which can happen part way.
const META_ATTACHMENTS_GROWING: &str = "attachments_growing";

fn hexes(found: &[Attachment]) -> HashSet<String> {
    found
        .iter()
        .filter_map(|attachment| crate::blob::hex_of(&attachment.hash).ok())
        .map(str::to_string)
        .collect()
}

/// The bytes the file cache keeps for attachments, by the hex of their hash.
pub fn kept_attachments(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare_cached("SELECT hex FROM attachment_bytes")?;
    let found = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<HashSet<String>, _>>()?;
    Ok(found)
}

/// Whether the kept set may only grow, because the copy is not whole.
pub fn attachments_growing(conn: &Connection) -> Result<bool, CoreError> {
    Ok(meta_get(conn, META_ATTACHMENTS_GROWING)?.is_some())
}

/// Called in the transaction that starts a hydration, before it clears the
/// copy.
pub fn attachments_start_growing(conn: &Connection) -> Result<(), CoreError> {
    meta_set(conn, META_ATTACHMENTS_GROWING, "1")
}

/// Called in the transaction that completes a hydration: the copy is whole,
/// so the kept set becomes exactly its attachments.
pub fn attachments_whole(conn: &Connection) -> Result<(), CoreError> {
    meta_delete(conn, META_ATTACHMENTS_GROWING)?;
    reconcile_attachments(conn)
}

/// Adds every attachment the copy holds to the kept set and, unless it is
/// growing, takes out the bytes no attachment names. For a store opened by
/// this build's writer, whose kept set may not have been kept.
pub fn reconcile_attachments(conn: &Connection) -> Result<(), CoreError> {
    let now = hexes(&attachments(conn)?);
    if !attachments_growing(conn)? {
        for hex in kept_attachments(conn)?.difference(&now) {
            conn.execute("DELETE FROM attachment_bytes WHERE hex = ?1", [hex])?;
        }
    }
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO attachment_bytes (hex) VALUES (?1)")?;
    for hex in now {
        insert.execute([hex])?;
    }
    Ok(())
}

/// The kept bytes a change to the rows or edges of `ids` can end, read
/// before the change, for `attachments_changed` after it.
pub(super) fn attachments_before(
    conn: &Connection,
    ids: &[&str],
) -> Result<HashSet<String>, CoreError> {
    Ok(hexes(&attachments_touching(conn, ids)?))
}

/// Brings the kept set up to a change to the rows or edges of `ids`, in the
/// transaction that made it: the bytes of an attachment it made are added,
/// and the bytes in `before` that no attachment names now go, unless the set
/// is growing.
pub(super) fn attachments_changed(
    conn: &Connection,
    ids: &[&str],
    before: HashSet<String>,
) -> Result<(), CoreError> {
    let now = hexes(&attachments_touching(conn, ids)?);
    let mut insert =
        conn.prepare_cached("INSERT OR IGNORE INTO attachment_bytes (hex) VALUES (?1)")?;
    for hex in &now {
        insert.execute([hex])?;
    }
    if before.is_subset(&now) || attachments_growing(conn)? {
        return Ok(());
    }
    for hex in before.difference(&now) {
        let named = [format!("{}{hex}", crate::blob::PREFIX), hex.clone()];
        let named: Vec<&str> = named.iter().map(String::as_str).collect();
        let condition = "CASE WHEN json_valid(f.properties)
                           THEN json_extract(f.properties, '$.blob_ref') END IN (?, ?)";
        if attachments_where(conn, condition, &named)?.is_empty() {
            conn.execute("DELETE FROM attachment_bytes WHERE hex = ?1", [hex])?;
        }
    }
    Ok(())
}

/// Why the last fetch of each kept attachment's bytes left them unheld, by
/// hex. Bytes that arrived, or no fetch has failed, have none.
pub fn attachment_misses(conn: &Connection) -> Result<HashMap<String, String>, CoreError> {
    let mut statement =
        conn.prepare_cached("SELECT hex, miss FROM attachment_bytes WHERE miss IS NOT NULL")?;
    let found = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<HashMap<String, String>, _>>()?;
    Ok(found)
}

/// Writes down why a fetch left the bytes `hex` unheld, or clears it with
/// `None` once they arrive. Bytes no attachment names are left alone.
pub fn set_attachment_miss(
    conn: &Connection,
    hex: &str,
    reason: Option<&str>,
) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE attachment_bytes SET miss = ?2 WHERE hex = ?1",
        params![hex, reason],
    )?;
    Ok(())
}

/// A taken upload may need resending, or hold a refused file's only copy.
pub fn kept_uploads(conn: &Connection) -> Result<HashSet<String>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT blob FROM queue
          WHERE kind = ?1 AND blob IS NOT NULL
            AND (verdict IS NULL OR verdict NOT IN (?2, ?3, ?4))",
    )?;
    let mut hashes = statement
        .query_map(
            [
                WriteKind::UploadBlob.as_str(),
                Verdict::Accepted.as_str(),
                Verdict::Merged.as_str(),
                Verdict::Conflicted.as_str(),
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<HashSet<_>, _>>()?;
    let mut statement = conn.prepare(
        "SELECT DISTINCT upload.blob, waiting.id, waiting.verdict = :refused
           FROM queue AS upload, queue AS waiting, json_each(waiting.depends_on) AS named
          WHERE upload.kind = :upload AND upload.blob IS NOT NULL
            AND upload.verdict IN (:accepted, :merged, :conflicted)
            AND named.value = upload.id
            AND (waiting.verdict IS NULL
                 OR waiting.verdict IN (:blocked, :dead)
                 OR waiting.verdict = :refused AND waiting.sent = 0
                 OR waiting.verdict = :refused AND waiting.reason = :bytes_absent)",
    )?;
    let waiting = statement
        .query_map(
            named_params! {
                ":upload": WriteKind::UploadBlob.as_str(),
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":blocked": Verdict::Blocked.as_str(),
                ":dead": Verdict::Dead.as_str(),
                ":refused": Verdict::Refused.as_str(),
                ":bytes_absent": BYTES_ABSENT,
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    for (hash, waiting, refused) in waiting {
        if hashes.contains(&hash) || refused && waits_for_withdrawn(conn, &waiting)? {
            continue;
        }
        hashes.insert(hash);
    }
    Ok(hashes)
}

/// Each taken upload, by its queue id and hash, that was sent with a
/// credential other than `credential` and that a write the next pass sends
/// waits on: one unanswered, or blocked for a reason that clears itself.
///
/// The server refuses a file write from a credential that neither sent its
/// bytes nor may read them (`blobs/proof-file-refused`). A write blocked for
/// good or dead is left until a release makes it unanswered, which the
/// record of the sending credential still covers.
pub fn uploads_to_send_again(
    conn: &Connection,
    credential: &str,
) -> Result<Vec<(String, String)>, CoreError> {
    let [credential_refused, awaiting] = SELF_CLEARING;
    let mut statement = conn.prepare(
        "SELECT upload.id, upload.blob FROM queue AS upload
          WHERE upload.kind = :upload AND upload.blob IS NOT NULL
            AND upload.verdict IN (:accepted, :merged, :conflicted)
            AND (SELECT value FROM meta WHERE key = 'sent_as/' || upload.id)
                IS NOT :credential
            AND EXISTS (
              SELECT 1 FROM queue AS waiting, json_each(waiting.depends_on) AS named
               WHERE named.value = upload.id
                 AND (waiting.verdict IS NULL
                      OR waiting.verdict = :blocked
                         AND waiting.reason IN (:credential_refused, :awaiting))
            )
          ORDER BY upload.seq",
    )?;
    let rows = statement
        .query_map(
            named_params! {
                ":upload": WriteKind::UploadBlob.as_str(),
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
                ":credential": credential,
                ":blocked": Verdict::Blocked.as_str(),
                ":credential_refused": credential_refused,
                ":awaiting": awaiting,
            },
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A taken upload made unanswered, so the next pass sends it again before
/// the writes that wait on it. An upload carries no idempotency key: the
/// door is idempotent by content.
pub fn send_upload_again(conn: &Connection, id: &str) -> Result<(), CoreError> {
    conn.execute(
        "UPDATE queue
            SET verdict = NULL, reason = NULL, answer = NULL,
                conflicted_copy_id = NULL, answered_at = NULL,
                refusals = 0, sent = 0
          WHERE id = ?1 AND kind = ?2",
        params![id, WriteKind::UploadBlob.as_str()],
    )?;
    Ok(())
}

pub const BYTES_ABSENT: &str = "blob_not_found";

fn bytes_sent_again_key(id: &str) -> String {
    format!("bytes_sent_again/{id}")
}

pub fn forget_bytes_sent_again(conn: &Connection, id: &str) -> Result<(), CoreError> {
    meta_delete(conn, &bytes_sent_again_key(id))
}

/// Whether the write `id` now waits, once, on its held uploads going again.
pub fn send_bytes_again(
    conn: &Connection,
    id: &str,
    held: impl Fn(&str) -> bool,
) -> Result<bool, CoreError> {
    let key = bytes_sent_again_key(id);
    if meta_get(conn, &key)?.is_some() {
        return Ok(false);
    }
    let mut statement = conn.prepare(
        "SELECT upload.id, upload.blob,
                EXISTS (SELECT 1 FROM queue AS ahead
                         WHERE ahead.kind = :upload AND ahead.blob = upload.blob
                           AND ahead.verdict IS NULL AND ahead.seq < waiting.seq)
           FROM queue AS waiting, json_each(waiting.depends_on) AS named, queue AS upload
          WHERE waiting.id = :id AND upload.id = named.value
            AND upload.kind = :upload AND upload.blob IS NOT NULL
            AND upload.verdict IN (:accepted, :merged, :conflicted)",
    )?;
    let taken = statement
        .query_map(
            named_params! {
                ":id": id,
                ":upload": WriteKind::UploadBlob.as_str(),
                ":accepted": Verdict::Accepted.as_str(),
                ":merged": Verdict::Merged.as_str(),
                ":conflicted": Verdict::Conflicted.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut waits = false;
    for (upload, hash, going) in taken {
        if !held(&hash) {
            continue;
        }
        if !going {
            send_upload_again(conn, &upload)?;
        }
        waits = true;
    }
    if waits {
        record_verdict(
            conn,
            id,
            &Answered {
                verdict: Verdict::Blocked,
                reason: Some(crate::model::AWAITING_DEPENDENCY),
                answer: None,
                conflicted_copy_id: None,
            },
        )?;
        meta_set(conn, &key, "1")?;
    }
    Ok(waits)
}
