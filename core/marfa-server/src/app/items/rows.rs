//! Nothing outside `items` reaches this module, so every write to these tables goes through `write`.

use rusqlite::{OptionalExtension, Row, ToSql, Transaction, params, params_from_iter};
use serde::Serialize;

use super::{Item, Keys, Mark, Snapshot, Writer};
use crate::app::blobs::references;
use crate::app::refusal::Result;

const ITEM: &str = "SELECT seq, id, type, state, tier, source, source_id, json(properties), \
     version, schema_version, occurred_at, created_at, updated_at, trashed_at, \
     capture_latitude, capture_longitude, link, trashed_by_kind, trashed_by_id, \
     trashed_by_name, trashed_with, trashed_with_type, went_with_hosts FROM items";

pub(super) struct Indexed {
    pub type_id: String,
    pub state: String,
    pub properties: String,
}

pub(super) fn indexed(tx: &Transaction<'_>, seq: i64) -> Result<Option<Indexed>> {
    let mut statement =
        tx.prepare_cached("SELECT type, state, json(properties) FROM items WHERE seq = ?1")?;
    Ok(statement
        .query_row([seq], |row| {
            Ok(Indexed {
                type_id: row.get(0)?,
                state: row.get(1)?,
                properties: row.get(2)?,
            })
        })
        .optional()?)
}

pub(super) fn seqs_of(
    tx: &Transaction<'_>,
    type_id: &str,
    state: &str,
    after: i64,
    limit: usize,
) -> Result<Vec<i64>> {
    let mut statement = tx.prepare_cached(
        "SELECT seq FROM items WHERE type = ?1 AND state = ?2 AND seq > ?3 ORDER BY seq LIMIT ?4",
    )?;
    let found = statement.query_map(params![type_id, state, after, limit as i64], |row| {
        row.get(0)
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// A row a snapshot holds is always found.
pub(super) fn by_seqs(tx: &Transaction<'_>, seqs: &[i64]) -> Result<Vec<Item>> {
    let mut statement = tx.prepare_cached(&format!("{ITEM} WHERE seq = ?1"))?;
    seqs.iter()
        .map(|seq| Ok(statement.query_row([seq], item_of)?))
        .collect()
}

const SNAPSHOT: &str = "SELECT v.id, i.id, v.version, json(v.properties), v.type, v.tier, \
     v.occurred_at, v.source_id, v.writer_kind, v.writer_id, v.writer_name, v.created_at \
     FROM item_versions v JOIN items i ON i.seq = v.item_seq";

fn writer_of(kind: Option<String>, id: Option<String>, name: Option<String>) -> Option<Writer> {
    kind.zip(id)
        .zip(name)
        .map(|((kind, id), name)| Writer { kind, id, name })
}

fn mark_of(with: Option<String>, with_type: Option<String>, hosts: bool) -> Option<Mark> {
    with.zip(with_type).map(|(with, with_type)| Mark {
        with,
        with_type,
        hosts,
    })
}

fn item_of(row: &Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        seq: row.get(0)?,
        id: row.get(1)?,
        type_id: row.get(2)?,
        state: row.get(3)?,
        tier: row.get(4)?,
        source: row.get(5)?,
        source_id: row.get(6)?,
        properties: row.get(7)?,
        version: row.get(8)?,
        schema_version: row.get(9)?,
        occurred_at: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        trashed_at: row.get(13)?,
        capture_latitude: row.get(14)?,
        capture_longitude: row.get(15)?,
        link: row.get(16)?,
        trashed_by: writer_of(row.get(17)?, row.get(18)?, row.get(19)?),
        mark: mark_of(row.get(20)?, row.get(21)?, row.get(22)?),
    })
}

fn snapshot_of(row: &Row<'_>) -> rusqlite::Result<Snapshot> {
    Ok(Snapshot {
        id: row.get(0)?,
        item_id: row.get(1)?,
        version: row.get(2)?,
        properties: row.get(3)?,
        type_id: row.get(4)?,
        tier: row.get(5)?,
        occurred_at: row.get(6)?,
        source_id: row.get(7)?,
        writer: writer_of(row.get(8)?, row.get(9)?, row.get(10)?),
        created_at: row.get(11)?,
    })
}

pub(super) fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Item>> {
    let mut statement = tx.prepare_cached(&format!("{ITEM} WHERE id = ?1"))?;
    Ok(statement.query_row([id], item_of).optional()?)
}

pub(super) fn by_natural_key(
    tx: &Transaction<'_>,
    source: &str,
    source_id: &str,
) -> Result<Option<Item>> {
    let mut statement =
        tx.prepare_cached(&format!("{ITEM} WHERE source = ?1 AND source_id = ?2"))?;
    Ok(statement
        .query_row([source, source_id], item_of)
        .optional()?)
}

pub(super) fn by_link(tx: &Transaction<'_>, type_id: &str, link: &str) -> Result<Option<Item>> {
    let mut statement = tx.prepare_cached(&format!("{ITEM} WHERE type = ?1 AND link = ?2"))?;
    Ok(statement.query_row([type_id, link], item_of).optional()?)
}

pub(super) fn link_holder(
    tx: &Transaction<'_>,
    type_id: &str,
    link: &str,
) -> Result<Option<String>> {
    let mut statement = tx.prepare_cached("SELECT id FROM items WHERE type = ?1 AND link = ?2")?;
    Ok(statement
        .query_row([type_id, link], |row| row.get(0))
        .optional()?)
}

pub(super) struct NewRow<'a> {
    pub id: &'a str,
    pub type_id: &'a str,
    pub state: &'a str,
    pub tier: Option<&'a str>,
    pub source: &'a str,
    pub source_id: Option<&'a str>,
    pub properties: &'a str,
    pub title_key: Option<&'a str>,
    pub schema_version: i64,
    pub occurred_at: &'a str,
    pub at: &'a str,
    pub trashed_at: Option<&'a str>,
    pub trashed_by: Option<&'a Writer>,
    pub link: Option<&'a str>,
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    pub writer: Option<&'a Writer>,
}

pub(super) fn insert(tx: &Transaction<'_>, row: &NewRow<'_>) -> Result<Item> {
    let mut statement = tx.prepare_cached(
        "INSERT INTO items (id, type, state, tier, source, source_id, properties, title_key, \
         version, schema_version, occurred_at, created_at, updated_at, trashed_at, \
         capture_latitude, capture_longitude, writer_kind, writer_id, writer_name, link, \
         trashed_by_kind, trashed_by_id, trashed_by_name) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, jsonb(?7), ?8, 1, ?9, ?10, ?11, ?11, ?12, ?13, ?14, \
         ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
    )?;
    statement.execute(params![
        row.id,
        row.type_id,
        row.state,
        row.tier,
        row.source,
        row.source_id,
        row.properties,
        row.title_key,
        row.schema_version,
        row.occurred_at,
        row.at,
        row.trashed_at,
        row.capture_latitude,
        row.capture_longitude,
        row.writer.map(|by| &by.kind),
        row.writer.map(|by| &by.id),
        row.writer.map(|by| &by.name),
        row.link,
        row.trashed_by.map(|by| &by.kind),
        row.trashed_by.map(|by| &by.id),
        row.trashed_by.map(|by| &by.name),
    ])?;
    clear_tombstones(tx, row.type_id, row.link, row.source, row.source_id)?;
    stored(tx, row.id)
}

fn clear_tombstones(
    tx: &Transaction<'_>,
    type_id: &str,
    link: Option<&str>,
    source: &str,
    source_id: Option<&str>,
) -> Result<()> {
    if let Some(link) = link {
        tx.prepare_cached("DELETE FROM link_tombstones WHERE type = ?1 AND value = ?2")?
            .execute([type_id, link])?;
    }
    if let Some(source_id) = source_id {
        tx.prepare_cached(
            "DELETE FROM natural_key_tombstones WHERE source = ?1 AND source_id = ?2",
        )?
        .execute([source, source_id])?;
    }
    Ok(())
}

fn stored(tx: &Transaction<'_>, id: &str) -> Result<Item> {
    by_id(tx, id)?.ok_or_else(|| crate::app::refusal::Refusal::internal("a written row is gone"))
}

pub(super) struct Landed<'a> {
    pub type_id: &'a str,
    pub tier: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub link: Option<&'a str>,
    pub properties: &'a str,
    pub title_key: Option<&'a str>,
    pub schema_version: i64,
    pub occurred_at: &'a str,
    pub at: &'a str,
    pub writer: Option<&'a Writer>,
}

pub(super) fn advance(
    tx: &Transaction<'_>,
    item: &Item,
    snapshot_id: &str,
    next: &Landed<'_>,
) -> Result<Item> {
    references::keep_version(tx, item.seq)?;
    tx.prepare_cached(
        "INSERT INTO item_versions (item_seq, version, id, properties, type, tier, occurred_at, \
         source_id, writer_kind, writer_id, writer_name, created_at) \
         SELECT seq, version, ?2, properties, type, tier, occurred_at, source_id, writer_kind, \
         writer_id, writer_name, ?3 FROM items WHERE seq = ?1",
    )?
    .execute(params![item.seq, snapshot_id, next.at])?;
    tx.prepare_cached(
        "UPDATE items SET type = ?2, tier = ?3, source_id = ?4, properties = jsonb(?5), \
         title_key = ?6, version = version + 1, schema_version = ?7, occurred_at = ?8, \
         updated_at = ?9, writer_kind = ?10, writer_id = ?11, writer_name = ?12, link = ?13 \
         WHERE seq = ?1",
    )?
    .execute(params![
        item.seq,
        next.type_id,
        next.tier,
        next.source_id,
        next.properties,
        next.title_key,
        next.schema_version,
        next.occurred_at,
        next.at,
        next.writer.map(|by| &by.kind),
        next.writer.map(|by| &by.id),
        next.writer.map(|by| &by.name),
        next.link,
    ])?;
    let same_link = next.link == item.link.as_deref() && next.type_id == item.type_id;
    let same_key = next.source_id == item.source_id.as_deref();
    clear_tombstones(
        tx,
        next.type_id,
        next.link.filter(|_| !same_link),
        &item.source,
        next.source_id.filter(|_| !same_key),
    )?;
    stored(tx, &item.id)
}

pub(super) struct Moved<'a> {
    pub state: &'a str,
    pub trashed_at: Option<&'a str>,
    pub trashed_by: Option<&'a Writer>,
    pub mark: Option<&'a Mark>,
    pub at: &'a str,
}

/// Moves a row to another state. Neither its version nor its history moves.
pub(super) fn move_state(tx: &Transaction<'_>, item: &Item, to: &Moved<'_>) -> Result<Item> {
    tx.prepare_cached(
        "UPDATE items SET state = ?2, trashed_at = ?3, trashed_by_kind = ?4, trashed_by_id = ?5, \
         trashed_by_name = ?6, updated_at = ?7, trashed_with = ?8, trashed_with_type = ?9, \
         went_with_hosts = ?10 WHERE seq = ?1",
    )?
    .execute(params![
        item.seq,
        to.state,
        to.trashed_at,
        to.trashed_by.map(|by| &by.kind),
        to.trashed_by.map(|by| &by.id),
        to.trashed_by.map(|by| &by.name),
        to.at,
        to.mark.map(|mark| &mark.with),
        to.mark.map(|mark| &mark.with_type),
        to.mark.is_some_and(|mark| mark.hosts),
    ])?;
    stored(tx, &item.id)
}

pub(super) fn marked_with(tx: &Transaction<'_>, root: &str) -> Result<Vec<Item>> {
    let mut statement = tx.prepare_cached(&format!(
        "{ITEM} WHERE trashed_with = ?1 AND state = 'trashed' ORDER BY seq"
    ))?;
    let found = statement.query_map([root], item_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

/// Deletes a row and all that hangs from it, leaving its tombstones.
pub(super) fn purge(tx: &Transaction<'_>, item: &Item, at: &str) -> Result<()> {
    if let Some(link) = &item.link {
        tx.execute(
            "INSERT INTO link_tombstones (type, value, purged_at, settled_at) \
             VALUES (?1, ?2, ?3, ?3) ON CONFLICT (type, value) \
             DO UPDATE SET purged_at = ?3, settled_at = ?3",
            params![item.type_id, link, at],
        )?;
    }
    if let Some(source_id) = &item.source_id {
        tx.execute(
            "INSERT INTO natural_key_tombstones (type, source, source_id, purged_at, settled_at) \
             VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (type, source, source_id) \
             DO UPDATE SET purged_at = ?4, settled_at = ?4",
            params![item.type_id, item.source, source_id, at],
        )?;
    }
    references::forget_item(tx, item.seq)?;
    tx.execute("DELETE FROM item_tags WHERE item_seq = ?1", [item.seq])?;
    tx.execute(
        "DELETE FROM item_extensions WHERE item_seq = ?1",
        [item.seq],
    )?;
    tx.execute("DELETE FROM item_versions WHERE item_seq = ?1", [item.seq])?;
    tx.execute("DELETE FROM items WHERE seq = ?1", [item.seq])?;
    Ok(())
}

#[derive(Serialize)]
pub(super) struct Tombstone {
    pub key: String,
    pub purged_at: String,
    pub settled_at: String,
}

fn tombstone_of(row: &Row<'_>) -> rusqlite::Result<Tombstone> {
    Ok(Tombstone {
        key: row.get(0)?,
        purged_at: row.get(1)?,
        settled_at: row.get(2)?,
    })
}

fn link_tombstone(tx: &Transaction<'_>, type_id: &str, value: &str) -> Result<Option<Tombstone>> {
    let mut statement = tx.prepare_cached(
        "SELECT value, purged_at, settled_at FROM link_tombstones WHERE type = ?1 AND value = ?2",
    )?;
    Ok(statement
        .query_row([type_id, value], tombstone_of)
        .optional()?)
}

fn key_tombstone(
    tx: &Transaction<'_>,
    type_id: &str,
    source: &str,
    source_id: &str,
) -> Result<Option<Tombstone>> {
    let mut statement = tx.prepare_cached(
        "SELECT source_id, purged_at, settled_at FROM natural_key_tombstones \
         WHERE type = ?1 AND source = ?2 AND source_id = ?3",
    )?;
    Ok(statement
        .query_row([type_id, source, source_id], tombstone_of)
        .optional()?)
}

/// Both times are canonical, so their text orders as they do.
pub(super) fn settle_link(
    tx: &Transaction<'_>,
    type_id: &str,
    value: &str,
    settled_at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "UPDATE link_tombstones SET settled_at = ?3 \
         WHERE type = ?1 AND value = ?2 AND settled_at < ?3",
    )?
    .execute([type_id, value, settled_at])?;
    Ok(())
}

pub(super) fn settle_key(
    tx: &Transaction<'_>,
    type_id: &str,
    source: &str,
    source_id: &str,
    settled_at: &str,
) -> Result<()> {
    tx.prepare_cached(
        "UPDATE natural_key_tombstones SET settled_at = ?4 \
         WHERE type = ?1 AND source = ?2 AND source_id = ?3 AND settled_at < ?4",
    )?
    .execute([type_id, source, source_id, settled_at])?;
    Ok(())
}

pub(super) fn tombstones(
    tx: &Transaction<'_>,
    type_id: &str,
    keys: &Keys,
) -> Result<Vec<Tombstone>> {
    let mut found = Vec::new();
    match keys {
        Keys::Links(links) => {
            for link in links {
                found.extend(link_tombstone(tx, type_id, link)?);
            }
        }
        Keys::Natural { source, source_ids } => {
            for source_id in source_ids {
                found.extend(key_tombstone(tx, type_id, source, source_id)?);
            }
        }
    }
    Ok(found)
}

pub(super) fn drop_link_tombstones(tx: &Transaction<'_>, type_id: &str) -> Result<()> {
    tx.execute("DELETE FROM link_tombstones WHERE type = ?1", [type_id])?;
    Ok(())
}

pub(super) fn drop_tombstones(tx: &Transaction<'_>, type_id: &str) -> Result<()> {
    drop_link_tombstones(tx, type_id)?;
    tx.execute(
        "DELETE FROM natural_key_tombstones WHERE type = ?1",
        [type_id],
    )?;
    Ok(())
}

/// Clears every row's link under `type_id`, so a recount meets no old value.
pub(super) fn clear_links(tx: &Transaction<'_>, type_id: &str) -> Result<()> {
    tx.execute(
        "UPDATE items SET link = NULL WHERE type = ?1 AND link IS NOT NULL",
        [type_id],
    )?;
    Ok(())
}

pub(super) fn set_link(tx: &Transaction<'_>, seq: i64, link: &str) -> Result<bool> {
    let set = tx.execute(
        "UPDATE items SET link = ?2 WHERE seq = ?1",
        params![seq, link],
    );
    match set {
        Ok(_) => Ok(false),
        Err(error)
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) =>
        {
            Ok(true)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn touch(tx: &Transaction<'_>, item: &Item, at: &str) -> Result<Item> {
    tx.execute(
        "UPDATE items SET updated_at = ?2 WHERE seq = ?1",
        params![item.seq, at],
    )?;
    stored(tx, &item.id)
}

pub(super) type Position = (String, String);

pub(super) fn newest(
    tx: &Transaction<'_>,
    trashed: bool,
    type_id: Option<&str>,
    after: Option<&Position>,
    limit: i64,
) -> Result<Vec<Item>> {
    let state = if trashed {
        "state = 'trashed'"
    } else {
        "state <> 'trashed'"
    };
    let bound = if after.is_some() {
        "(created_at, id) < (?2, ?3)"
    } else {
        "?2 IS NULL AND ?3 IS NULL"
    };
    let sql = format!(
        "{ITEM} WHERE {state} AND type NOT GLOB 'system.*' AND (?1 IS NULL OR type = ?1) AND {bound}
         ORDER BY created_at DESC, id DESC LIMIT ?4"
    );
    let (at, id) = after.map_or((None, None), |(at, id)| (Some(at), Some(id)));
    Ok(tx
        .prepare_cached(&sql)?
        .query_map(params![type_id, at, id, limit], item_of)?
        .collect::<rusqlite::Result<_>>()?)
}

pub(super) fn snapshot_at(
    tx: &Transaction<'_>,
    seq: i64,
    version: i64,
) -> Result<Option<Snapshot>> {
    Ok(tx
        .query_row(
            &format!("{SNAPSHOT} WHERE v.item_seq = ?1 AND v.version = ?2"),
            [seq, version],
            snapshot_of,
        )
        .optional()?)
}

pub(super) fn snapshots_after(
    tx: &Transaction<'_>,
    seq: i64,
    after: i64,
    limit: i64,
) -> Result<Vec<Snapshot>> {
    let mut statement = tx.prepare_cached(&format!(
        "{SNAPSHOT} WHERE v.item_seq = ?1 AND v.version > ?2 ORDER BY v.version LIMIT ?3"
    ))?;
    let found = statement.query_map([seq, after, limit], snapshot_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn tags(tx: &Transaction<'_>, seq: i64) -> Result<Vec<String>> {
    let mut statement =
        tx.prepare_cached("SELECT tag FROM item_tags WHERE item_seq = ?1 ORDER BY position")?;
    let found = statement.query_map([seq], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn add_tags(tx: &Transaction<'_>, seq: i64, tags: &[String]) -> Result<()> {
    let mut statement = tx.prepare_cached(
        "INSERT OR IGNORE INTO item_tags (item_seq, tag, position) VALUES (?1, ?2, \
         (SELECT COALESCE(MAX(position), -1) + 1 FROM item_tags WHERE item_seq = ?1))",
    )?;
    for tag in tags {
        statement.execute(params![seq, tag])?;
    }
    Ok(())
}

pub(super) fn set_tags(tx: &Transaction<'_>, seq: i64, tags: &[String]) -> Result<()> {
    tx.execute("DELETE FROM item_tags WHERE item_seq = ?1", [seq])?;
    add_tags(tx, seq, tags)
}

pub(super) fn remove_tag(tx: &Transaction<'_>, seq: i64, tag: &str) -> Result<()> {
    tx.execute(
        "DELETE FROM item_tags WHERE item_seq = ?1 AND tag = ?2",
        params![seq, tag],
    )?;
    Ok(())
}

pub(super) fn extensions(tx: &Transaction<'_>, seq: i64) -> Result<Vec<(String, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT namespace, json(data) FROM item_extensions WHERE item_seq = ?1 ORDER BY namespace",
    )?;
    let found = statement.query_map([seq], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn extension(tx: &Transaction<'_>, seq: i64, namespace: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT json(data) FROM item_extensions WHERE item_seq = ?1 AND namespace = ?2",
            params![seq, namespace],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn put_extension(
    tx: &Transaction<'_>,
    seq: i64,
    namespace: &str,
    data: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO item_extensions (item_seq, namespace, data) VALUES (?1, ?2, jsonb(?3)) \
         ON CONFLICT (item_seq, namespace) DO UPDATE SET data = excluded.data",
        params![seq, namespace, data],
    )?;
    Ok(())
}

pub(super) fn remove_extension(tx: &Transaction<'_>, seq: i64, namespace: &str) -> Result<()> {
    references::forget(tx, references::Row::Extension(seq, namespace))?;
    tx.execute(
        "DELETE FROM item_extensions WHERE item_seq = ?1 AND namespace = ?2",
        params![seq, namespace],
    )?;
    Ok(())
}

pub(super) fn active_tags(tx: &Transaction<'_>) -> Result<Vec<(String, String, String, i64)>> {
    let mut statement = tx.prepare_cached(
        "SELECT t.tag, i.type, i.source, COUNT(*) FROM item_tags t \
         JOIN items i ON i.seq = t.item_seq WHERE i.state = 'active' \
         GROUP BY t.tag, i.type, i.source",
    )?;
    let found = statement.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) struct Titled {
    pub id: String,
    pub type_id: String,
    pub source: String,
    pub properties: String,
    pub has_blob: bool,
}

pub(super) fn titled(
    tx: &Transaction<'_>,
    key: &str,
    after: &str,
    limit: i64,
) -> Result<Vec<Titled>> {
    let mut statement = tx.prepare_cached(
        "SELECT id, type, source, json(properties), \
         properties ->> '$.blob_ref' IS NOT NULL AND json_type(properties, '$.blob_ref') = 'text' \
         FROM items WHERE title_key = ?1 AND id > ?2 AND state IN ('active', 'archived') \
         ORDER BY id LIMIT ?3",
    )?;
    let found = statement.query_map(params![key, after, limit], |row| {
        Ok(Titled {
            id: row.get(0)?,
            type_id: row.get(1)?,
            source: row.get(2)?,
            properties: row.get(3)?,
            has_blob: row.get(4)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn count_of_type(tx: &Transaction<'_>, type_id: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COUNT(*) FROM items WHERE type = ?1",
        [type_id],
        |row| row.get(0),
    )?)
}

pub(super) fn held_names(
    tx: &Transaction<'_>,
    types: &[String],
    names: &[String],
) -> Result<Vec<String>> {
    let marks = vec!["?"; types.len()].join(", ");
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM items WHERE type IN ({marks}) \
         AND json_type(properties, ?) IS NOT NULL)"
    );
    let mut statement = tx.prepare(&sql)?;
    let mut held = Vec::new();
    for name in names {
        let path = format!("$.\"{}\"", name.replace('"', "\\\""));
        let mut values: Vec<&dyn ToSql> = types.iter().map(|id| id as &dyn ToSql).collect();
        values.push(&path);
        let found: bool = statement.query_row(params_from_iter(values), |row| row.get(0))?;
        if found {
            held.push(name.clone());
        }
    }
    Ok(held)
}

pub(super) fn of_type(tx: &Transaction<'_>, type_id: &str) -> Result<Vec<(i64, String)>> {
    let mut statement = tx.prepare("SELECT seq, json(properties) FROM items WHERE type = ?1")?;
    let found = statement.query_map([type_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn set_title_key(tx: &Transaction<'_>, seq: i64, key: Option<&str>) -> Result<()> {
    tx.execute(
        "UPDATE items SET title_key = ?2 WHERE seq = ?1",
        params![seq, key],
    )?;
    Ok(())
}
