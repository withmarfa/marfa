//! The SQL of the item tables. Nothing outside `items` reaches this module, so
//! every write to these tables goes through `write`.

use rusqlite::{OptionalExtension, Row, ToSql, Transaction, params, params_from_iter};

use super::{Item, Snapshot, Writer};
use crate::app::refusal::Result;

const ITEM: &str = "SELECT seq, id, type, state, tier, source, source_id, json(properties), \
     version, schema_version, occurred_at, created_at, updated_at, trashed_at, \
     capture_latitude, capture_longitude FROM items";

const SNAPSHOT: &str = "SELECT v.id, i.id, v.version, json(v.properties), v.type, v.tier, \
     v.occurred_at, v.source_id, v.writer_kind, v.writer_id, v.writer_name, v.created_at \
     FROM item_versions v JOIN items i ON i.seq = v.item_seq";

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
    })
}

fn snapshot_of(row: &Row<'_>) -> rusqlite::Result<Snapshot> {
    let kind: Option<String> = row.get(8)?;
    let id: Option<String> = row.get(9)?;
    let name: Option<String> = row.get(10)?;
    Ok(Snapshot {
        id: row.get(0)?,
        item_id: row.get(1)?,
        version: row.get(2)?,
        properties: row.get(3)?,
        type_id: row.get(4)?,
        tier: row.get(5)?,
        occurred_at: row.get(6)?,
        source_id: row.get(7)?,
        writer: kind
            .zip(id)
            .zip(name)
            .map(|((kind, id), name)| Writer { kind, id, name }),
        created_at: row.get(11)?,
    })
}

pub(super) fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Item>> {
    Ok(tx
        .query_row(&format!("{ITEM} WHERE id = ?1"), [id], item_of)
        .optional()?)
}

pub(super) fn by_natural_key(
    tx: &Transaction<'_>,
    source: &str,
    source_id: &str,
) -> Result<Option<Item>> {
    Ok(tx
        .query_row(
            &format!("{ITEM} WHERE source = ?1 AND source_id = ?2"),
            [source, source_id],
            item_of,
        )
        .optional()?)
}

/// What a new row holds.
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
    pub capture_latitude: Option<f64>,
    pub capture_longitude: Option<f64>,
    pub writer: &'a Writer,
}

/// Inserts a row at version 1, and answers it as it was stored.
pub(super) fn insert(tx: &Transaction<'_>, row: &NewRow<'_>) -> Result<Item> {
    tx.execute(
        "INSERT INTO items (id, type, state, tier, source, source_id, properties, title_key, \
         version, schema_version, occurred_at, created_at, updated_at, trashed_at, \
         capture_latitude, capture_longitude, writer_kind, writer_id, writer_name) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, jsonb(?7), ?8, 1, ?9, ?10, ?11, ?11, ?12, ?13, ?14, \
         ?15, ?16, ?17)",
        params![
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
            row.writer.kind,
            row.writer.id,
            row.writer.name,
        ],
    )?;
    stored(tx, row.id)
}

fn stored(tx: &Transaction<'_>, id: &str) -> Result<Item> {
    by_id(tx, id)?.ok_or_else(|| crate::app::refusal::Refusal::internal("a written row is gone"))
}

/// What a row holds once a write lands on it.
pub(super) struct Landed<'a> {
    pub type_id: &'a str,
    pub tier: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub properties: &'a str,
    pub title_key: Option<&'a str>,
    pub schema_version: i64,
    pub occurred_at: &'a str,
    pub at: &'a str,
    pub writer: &'a Writer,
}

/// Keeps `item` as it stands under its version and moves it to the next.
pub(super) fn advance(
    tx: &Transaction<'_>,
    item: &Item,
    snapshot_id: &str,
    next: &Landed<'_>,
) -> Result<Item> {
    tx.execute(
        "INSERT INTO item_versions (item_seq, version, id, properties, type, tier, occurred_at, \
         source_id, writer_kind, writer_id, writer_name, created_at) \
         SELECT seq, version, ?2, properties, type, tier, occurred_at, source_id, writer_kind, \
         writer_id, writer_name, ?3 FROM items WHERE seq = ?1",
        params![item.seq, snapshot_id, next.at],
    )?;
    tx.execute(
        "UPDATE items SET type = ?2, tier = ?3, source_id = ?4, properties = jsonb(?5), \
         title_key = ?6, version = version + 1, schema_version = ?7, occurred_at = ?8, \
         updated_at = ?9, writer_kind = ?10, writer_id = ?11, writer_name = ?12 WHERE seq = ?1",
        params![
            item.seq,
            next.type_id,
            next.tier,
            next.source_id,
            next.properties,
            next.title_key,
            next.schema_version,
            next.occurred_at,
            next.at,
            next.writer.kind,
            next.writer.id,
            next.writer.name,
        ],
    )?;
    stored(tx, &item.id)
}

/// Moves `updated_at` alone, for a write beside the item's own fields.
pub(super) fn touch(tx: &Transaction<'_>, item: &Item, at: &str) -> Result<Item> {
    tx.execute(
        "UPDATE items SET updated_at = ?2 WHERE seq = ?1",
        params![item.seq, at],
    )?;
    stored(tx, &item.id)
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

/// Up to `limit` snapshots after version `after`, oldest first.
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

/// Adds the tags the item does not hold, after the ones it does.
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

/// Every namespace the item holds, by name, each with its data as text.
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
    tx.execute(
        "DELETE FROM item_extensions WHERE item_seq = ?1 AND namespace = ?2",
        params![seq, namespace],
    )?;
    Ok(())
}

/// Each tag on an active item, with its count under each type and source.
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

/// What a title lookup answers of one item.
pub(super) struct Titled {
    pub id: String,
    pub type_id: String,
    pub source: String,
    pub properties: String,
    pub has_blob: bool,
}

/// The listed items under `key`, in `id` order, from `after`.
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

/// Which of `names` a stored property of an item of one of `types` holds, in
/// any state.
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

/// Each row of `type_id` as `(seq, type, properties)`, for rekeying.
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
