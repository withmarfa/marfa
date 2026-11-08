//! Nothing outside `edges` reaches this module, so every write to the table goes through `write`.

use marfa_rules::edges::{Graph, Link, OnDelete};
use rusqlite::{OptionalExtension, Row, ToSql, Transaction, params, params_from_iter};

use super::Edge;
use crate::app::blobs::references;
use crate::app::catalog::Catalog;
use crate::app::refusal::{Refusal, Result};

const EDGE: &str = "SELECT seq, id, source_id, target_id, edge_type, json(properties), version, \
     created_at, updated_at FROM edges";

fn edge_of(row: &Row<'_>) -> rusqlite::Result<Edge> {
    Ok(Edge {
        seq: row.get(0)?,
        id: row.get(1)?,
        source_id: row.get(2)?,
        target_id: row.get(3)?,
        edge_type: row.get(4)?,
        properties: row.get(5)?,
        version: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub(super) fn by_id(tx: &Transaction<'_>, id: &str) -> Result<Option<Edge>> {
    let mut statement = tx.prepare_cached(&format!("{EDGE} WHERE id = ?1"))?;
    Ok(statement.query_row([id], edge_of).optional()?)
}

pub(super) fn by_triple(
    tx: &Transaction<'_>,
    source: &str,
    target: &str,
    edge_type: &str,
) -> Result<Option<Edge>> {
    let mut statement = tx.prepare_cached(&format!(
        "{EDGE} WHERE source_id = ?1 AND target_id = ?2 AND edge_type = ?3"
    ))?;
    Ok(statement
        .query_row([source, target, edge_type], edge_of)
        .optional()?)
}

pub(super) fn leaving(tx: &Transaction<'_>, id: &str, edge_type: &str) -> Result<Vec<Edge>> {
    let mut statement = tx.prepare_cached(&format!(
        "{EDGE} WHERE source_id = ?1 AND edge_type = ?2 ORDER BY created_at, id"
    ))?;
    let found = statement.query_map([id, edge_type], edge_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn touching(tx: &Transaction<'_>, id: &str) -> Result<Vec<Edge>> {
    let mut statement = tx.prepare_cached(&format!(
        "{EDGE} WHERE source_id = ?1 UNION ALL {EDGE} WHERE target_id = ?1 AND source_id <> ?1"
    ))?;
    let found = statement.query_map([id], edge_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) struct NewEdge<'a> {
    pub id: &'a str,
    pub source_id: &'a str,
    pub target_id: &'a str,
    pub edge_type: &'a str,
    pub properties: &'a str,
    pub at: &'a str,
}

pub(super) fn insert(tx: &Transaction<'_>, edge: &NewEdge<'_>) -> Result<Edge> {
    tx.prepare_cached(
        "INSERT INTO edges (id, source_id, target_id, edge_type, properties, version, \
         created_at, updated_at) VALUES (?1, ?2, ?3, ?4, jsonb(?5), 1, ?6, ?6)",
    )?
    .execute(params![
        edge.id,
        edge.source_id,
        edge.target_id,
        edge.edge_type,
        edge.properties,
        edge.at
    ])?;
    stored(tx, edge.id)
}

pub(super) struct Landed<'a> {
    pub source_id: &'a str,
    pub target_id: &'a str,
    pub properties: &'a str,
    pub at: &'a str,
}

pub(super) fn advance(tx: &Transaction<'_>, edge: &Edge, next: &Landed<'_>) -> Result<Edge> {
    tx.prepare_cached(
        "UPDATE edges SET source_id = ?2, target_id = ?3, properties = jsonb(?4), \
         version = version + 1, updated_at = ?5 WHERE seq = ?1",
    )?
    .execute(params![
        edge.seq,
        next.source_id,
        next.target_id,
        next.properties,
        next.at
    ])?;
    stored(tx, &edge.id)
}

pub(super) fn delete(tx: &Transaction<'_>, edge: &Edge) -> Result<()> {
    references::forget(tx, references::Row::Edge(edge.seq))?;
    tx.prepare_cached("DELETE FROM edges WHERE seq = ?1")?
        .execute([edge.seq])?;
    Ok(())
}

fn stored(tx: &Transaction<'_>, id: &str) -> Result<Edge> {
    by_id(tx, id)?.ok_or_else(|| Refusal::internal("a written edge is gone"))
}

pub(super) fn count_of_type(tx: &Transaction<'_>, edge_type: &str) -> Result<i64> {
    Ok(tx
        .prepare_cached("SELECT COUNT(*) FROM edges WHERE edge_type = ?1")?
        .query_row([edge_type], |row| row.get(0))?)
}

pub(super) fn target_types(tx: &Transaction<'_>, edge_type: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT DISTINCT i.type FROM edges e JOIN items i ON i.id = e.target_id \
         WHERE e.edge_type = ?1 ORDER BY i.type",
    )?;
    let found = statement.query_map([edge_type], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn kinds_at(
    tx: &Transaction<'_>,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<Vec<String>> {
    let (column, id) = match (from, to) {
        (Some(id), _) => ("source_id", id),
        (None, Some(id)) => ("target_id", id),
        (None, None) => return Ok(Vec::new()),
    };
    let mut statement = tx.prepare_cached(&format!(
        "SELECT DISTINCT edge_type FROM edges WHERE {column} = ?1 ORDER BY edge_type"
    ))?;
    let found = statement.query_map([id], |row| row.get(0))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) type Position = (String, String);

#[derive(Clone, Copy)]
pub(super) struct Page<'a> {
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub edge_types: &'a [String],
    pub updated_after: Option<&'a str>,
    pub updated_before: Option<&'a str>,
    pub after: Option<&'a Position>,
    pub by_change: bool,
    pub limit: i64,
}

pub(super) fn page(
    tx: &Transaction<'_>,
    page: &Page<'_>,
    keeps: impl Fn(&str, &str) -> bool,
) -> Result<Vec<Edge>> {
    let mut sql = format!("{EDGE} WHERE 1 = 1");
    let mut values: Vec<&dyn ToSql> = Vec::new();
    if let Some(from) = &page.from {
        values.push(from);
        sql.push_str(&format!(" AND source_id = ?{}", values.len()));
    }
    if let Some(to) = &page.to {
        values.push(to);
        sql.push_str(&format!(" AND target_id = ?{}", values.len()));
    }
    if !page.edge_types.is_empty() {
        let mut marks = Vec::with_capacity(page.edge_types.len());
        for edge_type in page.edge_types {
            values.push(edge_type);
            marks.push(format!("?{}", values.len()));
        }
        sql.push_str(&format!(" AND edge_type IN ({})", marks.join(", ")));
    }
    if let Some(after) = &page.updated_after {
        values.push(after);
        sql.push_str(&format!(" AND updated_at >= ?{}", values.len()));
    }
    if let Some(before) = &page.updated_before {
        values.push(before);
        sql.push_str(&format!(" AND updated_at < ?{}", values.len()));
    }
    let (column, sense, order) = if page.by_change {
        ("updated_at", ">", "ASC")
    } else {
        ("created_at", "<", "DESC")
    };
    if let Some((at, id)) = page.after {
        values.push(at);
        values.push(id);
        let count = values.len();
        sql.push_str(&format!(
            " AND ({column}, id) {sense} (?{}, ?{count})",
            count - 1
        ));
    }
    sql.push_str(&format!(" ORDER BY {column} {order}, id {order}"));
    let mut statement = tx.prepare(&sql)?;
    let mut found = statement.query(params_from_iter(values))?;
    let mut kept = Vec::new();
    let mut sources = SourceCache::new(tx);
    while let Some(row) = found.next()? {
        let edge = edge_of(row)?;
        let held = sources.of(&edge.source_id)?;
        if held.is_some_and(|(type_id, source)| keeps(type_id, source)) {
            kept.push(edge);
            if kept.len() as i64 >= page.limit {
                break;
            }
        }
    }
    Ok(kept)
}

struct SourceCache<'a, 'c> {
    tx: &'a Transaction<'c>,
    held: std::collections::HashMap<String, Option<(String, String)>>,
}

impl<'a, 'c> SourceCache<'a, 'c> {
    fn new(tx: &'a Transaction<'c>) -> SourceCache<'a, 'c> {
        SourceCache {
            tx,
            held: std::collections::HashMap::new(),
        }
    }

    fn of(&mut self, id: &str) -> Result<Option<(&str, &str)>> {
        if !self.held.contains_key(id) {
            let found = self
                .tx
                .prepare_cached("SELECT type, source FROM items WHERE id = ?1")?
                .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            self.held.insert(id.to_string(), found);
        }
        Ok(self
            .held
            .get(id)
            .and_then(Option::as_ref)
            .map(|(type_id, source)| (type_id.as_str(), source.as_str())))
    }
}

pub(super) fn hosts_out_of_bin(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Vec<(String, String, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT e.edge_type, h.type, json(h.properties) FROM edges e \
         JOIN items h ON h.id = e.target_id \
         WHERE e.source_id = ?1 AND h.state <> 'trashed' \
         ORDER BY e.created_at, e.id",
    )?;
    let found = statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(crate) struct Store<'a, 'c> {
    pub tx: &'a Transaction<'c>,
    pub catalog: &'a Catalog,
}

fn links(tx: &Transaction<'_>, column: &str, id: &str) -> Result<Vec<Link>> {
    let mut statement = tx.prepare_cached(&format!(
        "SELECT id, edge_type, source_id, target_id FROM edges WHERE {column} = ?1"
    ))?;
    let found = statement.query_map([id], |row| {
        Ok(Link {
            id: row.get(0)?,
            edge_type: row.get(1)?,
            source: row.get(2)?,
            target: row.get(3)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

impl Graph for Store<'_, '_> {
    type Error = Refusal;

    fn outbound(&self, id: &str) -> Result<Vec<Link>> {
        links(self.tx, "source_id", id)
    }

    fn inbound(&self, id: &str) -> Result<Vec<Link>> {
        links(self.tx, "target_id", id)
    }

    fn triple(&self, source: &str, target: &str, edge_type: &str) -> Result<Option<String>> {
        Ok(by_triple(self.tx, source, target, edge_type)?.map(|edge| edge.id))
    }

    fn in_bin(&self, id: &str) -> Result<bool> {
        Ok(self
            .tx
            .prepare_cached("SELECT state = 'trashed' FROM items WHERE id = ?1")?
            .query_row([id], |row| row.get(0))
            .optional()?
            .unwrap_or(false))
    }

    fn holds(&self, id: &str) -> Result<bool> {
        Ok(self
            .tx
            .prepare_cached("SELECT 1 FROM items WHERE id = ?1")?
            .query_row([id], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn on_delete(&self, edge_type: &str) -> OnDelete {
        OnDelete::of(
            self.catalog
                .edge_kind(edge_type)
                .map(|kind| kind.cascade_on_delete.as_str()),
        )
    }
}
