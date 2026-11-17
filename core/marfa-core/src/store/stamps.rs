//! How a server row comes into the copy: stamps, the rows held beneath writes and the reads owed back.

use super::completeness::refilling;
use super::meta::meta_set;
use super::queue::{
    current_item_writes, edge_write_waits, row_writes_wait, untaken_create_for_edge,
    untaken_creates_for_item,
};
use super::reach::edge_brought;
use super::reads::{edge_by_id, edge_ends, items_by_ids};
use super::rows::{upsert_edge, upsert_item};
use super::time::instant_of;
use crate::error::CoreError;
use crate::model::{Edge, Item, QueuedWrite, Subject, WriteKind};
use crate::wire::{WireEdge, WireItem};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

/// Where a row or an edge stands in the order the server writes it: the
/// version, then the modification time. The version moves only on a write to
/// the fields, so a transition, a delete, a restore and a tag write share it
/// with the row before them; the time the server stamps on every write, and
/// never moves back, orders those.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub version: i64,
    pub updated_at: String,
}

impl Stamp {
    /// A time either side cannot read leaves the version alone to order
    /// them, so an equal version is never later.
    pub fn later_than(&self, other: &Stamp) -> bool {
        if self.version != other.version {
            return self.version > other.version;
        }
        match (instant_of(&self.updated_at), instant_of(&other.updated_at)) {
            (Some(held), Some(other)) => held > other,
            _ => false,
        }
    }
}

pub fn stamp(conn: &Connection, subject: Subject, id: &str) -> Result<Option<Stamp>, CoreError> {
    let table = match subject {
        Subject::Item => "items",
        Subject::Edge => "edges",
    };
    Ok(conn
        .prepare_cached(&format!(
            "SELECT version, updated_at FROM {table} WHERE id = ?1"
        ))?
        .query_row([id], |row| {
            Ok(Stamp {
                version: row.get(0)?,
                updated_at: row.get(1)?,
            })
        })
        .optional()?)
}

/// Whether the copy holds `id` at a stamp later than the one given.
pub fn holds_later(
    conn: &Connection,
    subject: Subject,
    id: &str,
    version: i64,
    updated_at: &str,
) -> Result<bool, CoreError> {
    let other = Stamp {
        version,
        updated_at: updated_at.to_string(),
    };
    Ok(stamp(conn, subject, id)?.is_some_and(|held| held.later_than(&other)))
}

/// The one way a server's row comes into the copy, whatever brought it: a
/// write's answer, a read-back, a landed create, a pin, an event or a
/// hydration. Refused where the copy holds the row at a later stamp, which a
/// follow on the same core can have brought while the row was being read;
/// answers whether it wrote. Either way the copy now holds a row the server
/// wrote, so a read-back owed for it is settled.
pub(crate) fn put_server_item(
    conn: &Connection,
    item: &WireItem,
    tags: Option<&[String]>,
    catalog: &marfa_rules::catalog::Catalog,
) -> Result<bool, CoreError> {
    settle_read_back(conn, Subject::Item, &item.id)?;
    if holds_later(
        conn,
        Subject::Item,
        &item.id,
        item.version,
        &item.updated_at,
    )? {
        return Ok(false);
    }
    let beneath_tags = match tags {
        Some(tags) => Some(tags.to_vec()),
        None => beneath_item(conn, &item.id)?.map(|held| held.tags),
    };
    upsert_item(conn, item, tags, &catalog.indexing(&item.r#type))?;
    keep_beneath_item(conn, &item.id, beneath_tags)?;
    if crate::body::rule::drops_on_landing(conn, &item.id)?
        && current_item_writes(conn, &item.id)?.is_empty()
    {
        crate::body::rule::landed(conn, catalog, &item.id)?;
    }
    Ok(true)
}

/// `put_server_item` for an edge.
pub(crate) fn put_server_edge(conn: &Connection, edge: &WireEdge) -> Result<bool, CoreError> {
    settle_read_back(conn, Subject::Edge, &edge.id)?;
    if refilling(conn)? {
        meta_set(conn, &edge_brought(&edge.id), "true")?;
    }
    if holds_later(
        conn,
        Subject::Edge,
        &edge.id,
        edge.version,
        &edge.updated_at,
    )? {
        return Ok(false);
    }
    upsert_edge(conn, edge)?;
    if edge_write_waits(conn, &edge.id)?
        && let Some(held) = edge_by_id(conn, &edge.id)?
    {
        set_beneath(
            conn,
            Subject::Edge,
            &edge.id,
            &serde_json::to_string(&held)?,
        )?;
    } else {
        drop_beneath(conn, Subject::Edge, &edge.id)?;
    }
    Ok(true)
}

fn subject_name(subject: Subject) -> &'static str {
    match subject {
        Subject::Item => "item",
        Subject::Edge => "edge",
    }
}

pub(super) fn set_beneath(
    conn: &Connection,
    subject: Subject,
    id: &str,
    row: &str,
) -> Result<(), CoreError> {
    conn.prepare_cached(
        "INSERT INTO beneath (subject, id, row) VALUES (?1, ?2, ?3)
         ON CONFLICT (subject, id) DO UPDATE SET row = excluded.row",
    )?
    .execute(params![subject_name(subject), id, row])?;
    Ok(())
}

pub(super) fn drop_beneath(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM beneath WHERE subject = ?1 AND id = ?2")?
        .execute(params![subject_name(subject), id])?;
    Ok(())
}

pub(super) fn beneath_row(
    conn: &Connection,
    subject: Subject,
    id: &str,
) -> Result<Option<String>, CoreError> {
    Ok(conn
        .prepare_cached("SELECT row FROM beneath WHERE subject = ?1 AND id = ?2")?
        .query_row(params![subject_name(subject), id], |row| row.get(0))
        .optional()?)
}

pub fn beneath_item(conn: &Connection, id: &str) -> Result<Option<Item>, CoreError> {
    match beneath_row(conn, Subject::Item, id)? {
        Some(row) => Ok(Some(serde_json::from_str(&row)?)),
        None => Ok(None),
    }
}

pub fn beneath_edge(conn: &Connection, id: &str) -> Result<Option<Edge>, CoreError> {
    match beneath_row(conn, Subject::Edge, id)? {
        Some(row) => Ok(Some(serde_json::from_str::<Edge>(&row)?)),
        None => Ok(None),
    }
}

/// Keeps the row the copy holds as the one beneath its waiting writes, with
/// `tags` where the copy's own may carry a waiting tag write, or lets it go
/// where none waits. Call only while the copy holds the server's row as
/// written, before anything is laid over it.
pub(super) fn keep_beneath_item(
    conn: &Connection,
    id: &str,
    tags: Option<Vec<String>>,
) -> Result<(), CoreError> {
    if !row_writes_wait(conn, id)? {
        return drop_beneath(conn, Subject::Item, id);
    }
    let Some(mut held) = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop() else {
        return drop_beneath(conn, Subject::Item, id);
    };
    if let Some(tags) = tags {
        held.tags = tags;
    }
    set_beneath(conn, Subject::Item, id, &serde_json::to_string(&held)?)
}

/// Before a local write changes a row: the row as the copy holds it is what
/// the server holds, unless writes already wait on it, which have kept what
/// is beneath them, or it is this device's own create the server has not
/// taken, which has nothing beneath it.
pub fn hold_beneath_item(conn: &Connection, id: &str) -> Result<(), CoreError> {
    if beneath_row(conn, Subject::Item, id)?.is_some()
        || !untaken_creates_for_item(conn, id)?.is_empty()
    {
        return Ok(());
    }
    if let Some(held) = items_by_ids(conn, std::slice::from_ref(&id.to_string()))?.pop() {
        set_beneath(conn, Subject::Item, id, &serde_json::to_string(&held)?)?;
    }
    Ok(())
}

/// `hold_beneath_item` for an edge.
pub fn hold_beneath_edge(conn: &Connection, id: &str) -> Result<(), CoreError> {
    if beneath_row(conn, Subject::Edge, id)?.is_some()
        || !untaken_create_for_edge(conn, id)?.is_empty()
    {
        return Ok(());
    }
    if let Some(held) = edge_by_id(conn, id)? {
        set_beneath(conn, Subject::Edge, id, &serde_json::to_string(&held)?)?;
    }
    Ok(())
}

/// A refused write's subject the copy owes a read of the server's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owed {
    pub subject: Subject,
    pub id: String,
    /// An edge's from item, whose listing of the edge's type it is read from.
    pub from_id: Option<String>,
    pub edge_type: Option<String>,
    /// The refused write moved the row, so a read outside the slice lets it go.
    pub moved: bool,
}

/// What a read-back of `row` reads, or `None` where it names nothing the
/// copy holds a row for.
pub fn owed_of(conn: &Connection, row: &QueuedWrite) -> Result<Option<Owed>, CoreError> {
    match row.kind.subject() {
        Some(Subject::Item) => Ok(row.item_id.as_ref().map(|id| Owed {
            subject: Subject::Item,
            id: id.clone(),
            from_id: None,
            edge_type: None,
            moved: row.kind == WriteKind::UpdateItem && moves(&row.body),
        })),
        Some(Subject::Edge) => {
            let (Some(source), Some(id)) = (row.item_id.as_ref(), row.edge_id.as_ref()) else {
                return Ok(None);
            };
            // A delete emptied the copy at queue time, so the type can come
            // only from the payload.
            let edge_type = match edge_ends(conn, id)? {
                Some(edge) => Some(edge.edge_type),
                None => row
                    .body
                    .get("edge_type")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            Ok(Some(Owed {
                subject: Subject::Edge,
                id: id.clone(),
                from_id: Some(source.clone()),
                edge_type,
                moved: false,
            }))
        }
        None => Ok(None),
    }
}

/// An update that moves the row to another type or tier.
pub fn moves(body: &Value) -> bool {
    body.get("retype") == Some(&Value::Bool(true)) || body.get("tier").is_some()
}

pub fn owe_read_back(conn: &Connection, owed: &Owed) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO read_backs (subject, id, from_id, edge_type, moved)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (subject, id) DO UPDATE SET
           from_id = coalesce(excluded.from_id, from_id),
           edge_type = coalesce(excluded.edge_type, edge_type),
           moved = moved OR excluded.moved",
        params![
            subject_name(owed.subject),
            owed.id,
            owed.from_id,
            owed.edge_type,
            owed.moved
        ],
    )?;
    Ok(())
}

pub fn owed_read_backs(conn: &Connection) -> Result<Vec<Owed>, CoreError> {
    let mut statement = conn.prepare(
        "SELECT subject, id, from_id, edge_type, moved FROM read_backs ORDER BY subject, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Owed {
                subject: Subject::Item,
                id: row.get(1)?,
                from_id: row.get(2)?,
                edge_type: row.get(3)?,
                moved: row.get(4)?,
            },
        ))
    })?;
    let mut owed = Vec::new();
    for row in rows {
        let (subject, mut entry) = row?;
        entry.subject = if subject == "edge" {
            Subject::Edge
        } else {
            Subject::Item
        };
        owed.push(entry);
    }
    Ok(owed)
}

pub fn settle_read_back(conn: &Connection, subject: Subject, id: &str) -> Result<(), CoreError> {
    conn.prepare_cached("DELETE FROM read_backs WHERE subject = ?1 AND id = ?2")?
        .execute(params![subject_name(subject), id])?;
    Ok(())
}

pub fn held_version(conn: &Connection, id: &str) -> Result<Option<i64>, CoreError> {
    Ok(conn
        .query_row("SELECT version FROM items WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?)
}
