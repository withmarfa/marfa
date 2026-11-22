//! Nothing outside `edges` reaches this module, so every write to the table goes through `write`.

use marfa_rules::edges::{Graph, Link, OnDelete};
use rusqlite::{OptionalExtension, Row, Transaction, params, params_from_iter};

use super::Edge;
use crate::app::blobs::references;
use crate::app::catalog::Catalog;
use crate::app::query::{Reach, Sql};
use crate::app::refusal::{Refusal, Result};

const EDGE: &str = "SELECT seq, id, from_id, to_id, edge_type, json(properties), version, \
     created_at, updated_at FROM edges";

fn edge_of(row: &Row<'_>) -> rusqlite::Result<Edge> {
    Ok(Edge {
        seq: row.get(0)?,
        id: row.get(1)?,
        from_id: row.get(2)?,
        to_id: row.get(3)?,
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
        "{EDGE} WHERE from_id = ?1 AND to_id = ?2 AND edge_type = ?3"
    ))?;
    Ok(statement
        .query_row([source, target, edge_type], edge_of)
        .optional()?)
}

pub(super) fn leaving(tx: &Transaction<'_>, id: &str, edge_type: &str) -> Result<Vec<Edge>> {
    let mut statement = tx.prepare_cached(&format!(
        "{EDGE} WHERE from_id = ?1 AND edge_type = ?2 ORDER BY created_at, id"
    ))?;
    let found = statement.query_map([id, edge_type], edge_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) fn touching(tx: &Transaction<'_>, id: &str) -> Result<Vec<Edge>> {
    let mut statement = tx.prepare_cached(&format!(
        "{EDGE} WHERE from_id = ?1 UNION ALL {EDGE} WHERE to_id = ?1 AND from_id <> ?1"
    ))?;
    let found = statement.query_map([id], edge_of)?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

pub(super) struct NewEdge<'a> {
    pub id: &'a str,
    pub from_id: &'a str,
    pub to_id: &'a str,
    pub edge_type: &'a str,
    pub properties: &'a str,
    pub at: &'a str,
}

pub(super) fn insert(tx: &Transaction<'_>, edge: &NewEdge<'_>) -> Result<Edge> {
    tx.prepare_cached(
        "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, \
         created_at, updated_at) VALUES (?1, ?2, ?3, ?4, jsonb(?5), 1, ?6, ?6)",
    )?
    .execute(params![
        edge.id,
        edge.from_id,
        edge.to_id,
        edge.edge_type,
        edge.properties,
        edge.at
    ])?;
    stored(tx, edge.id)
}

/// An edge as an archive holds it: its version and dates are kept.
pub(super) fn insert_restored(
    tx: &Transaction<'_>,
    edge: &NewEdge<'_>,
    version: i64,
    updated_at: &str,
) -> Result<Edge> {
    tx.prepare_cached(
        "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, \
         created_at, updated_at) VALUES (?1, ?2, ?3, ?4, jsonb(?5), ?6, ?7, ?8)",
    )?
    .execute(params![
        edge.id,
        edge.from_id,
        edge.to_id,
        edge.edge_type,
        edge.properties,
        version,
        edge.at,
        updated_at
    ])?;
    stored(tx, edge.id)
}

pub(super) struct Landed<'a> {
    pub from_id: &'a str,
    pub to_id: &'a str,
    pub properties: &'a str,
    pub at: &'a str,
}

pub(super) fn advance(tx: &Transaction<'_>, edge: &Edge, next: &Landed<'_>) -> Result<Edge> {
    tx.prepare_cached(
        "UPDATE edges SET from_id = ?2, to_id = ?3, properties = jsonb(?4), \
         version = version + 1, updated_at = ?5 WHERE seq = ?1",
    )?
    .execute(params![
        edge.seq,
        next.from_id,
        next.to_id,
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

pub(super) fn to_types(tx: &Transaction<'_>, edge_type: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(
        "SELECT DISTINCT i.type FROM edges e JOIN items i ON i.id = e.to_id \
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
        (Some(id), _) => ("from_id", id),
        (None, Some(id)) => ("to_id", id),
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

const EDGE_FROM: &str = "SELECT e.seq, e.id, e.from_id, e.to_id, e.edge_type, json(e.properties), \
     e.version, e.created_at, e.updated_at FROM edges e JOIN items f ON f.id = e.from_id";

/// The fewest edges a narrowed page walks in order before it asks the indexes instead.
const WINDOW: i64 = 1_000;

/// `from` holds the from item to a reach and `page.edge_types` the edge types, both in the
/// query; `keeps` judges each edge type too, before the limit, so a page comes back short only
/// at its end.
pub(super) fn page(
    tx: &Transaction<'_>,
    page: &Page<'_>,
    from: Option<&Reach>,
    keeps: impl Fn(&str) -> bool,
) -> Result<Vec<Edge>> {
    if let Some(window) = window_of(page, from) {
        let (kept, walked) = walk_window(tx, page, from, window, &keeps)?;
        if kept.len() as i64 >= page.limit || walked < window {
            return Ok(kept);
        }
    }
    let sql = page_sql(page, from);
    let mut statement = tx.prepare_cached(&sql.text)?;
    let mut found = statement.query(params_from_iter(&sql.values))?;
    let mut kept = Vec::new();
    while let Some(row) = found.next()? {
        let edge = edge_of(row)?;
        if keeps(&edge.edge_type) {
            kept.push(edge);
            if kept.len() as i64 >= page.limit {
                break;
            }
        }
    }
    Ok(kept)
}

/// A dense page fills from the newest edges in order, but the order index finds a sparse one
/// only by walking the table, where an index on what the caller reads finds it at once. So a
/// narrowed page walks a window first, and asks the indexes only when the window runs out.
fn window_of(page: &Page<'_>, from: Option<&Reach>) -> Option<i64> {
    let ordered_by_type = page.edge_types.len() == 1 && !page.by_change;
    let narrowed = from.is_some() || !page.edge_types.is_empty();
    (narrowed && !held_to_an_item(page) && !(from.is_none() && ordered_by_type))
        .then(|| (page.limit * 10).max(WINDOW))
}

/// A page of one item's edges reads them through that item's index, whatever the caller reads.
fn held_to_an_item(page: &Page<'_>) -> bool {
    page.from.is_some() || page.to.is_some()
}

fn order_of(page: &Page<'_>) -> (&'static str, &'static str, &'static str) {
    if page.by_change {
        ("updated_at", ">", "ASC")
    } else {
        ("created_at", "<", "DESC")
    }
}

/// What every edge of the page holds to, whatever reads it.
fn bounds(sql: &mut Sql, page: &Page<'_>) {
    if let Some(from) = page.from {
        sql.push(" AND e.from_id = ");
        sql.bind(from.to_string());
    }
    if let Some(to) = page.to {
        sql.push(" AND e.to_id = ");
        sql.bind(to.to_string());
    }
    if let Some(after) = page.updated_after {
        sql.push(" AND e.updated_at >= ");
        sql.bind(after.to_string());
    }
    if let Some(before) = page.updated_before {
        sql.push(" AND e.updated_at < ");
        sql.bind(before.to_string());
    }
    let (column, sense, _) = order_of(page);
    if let Some((at, id)) = page.after {
        sql.push(&format!(" AND (e.{column}, e.id) {sense} ("));
        sql.bind(at.clone());
        sql.push(", ");
        sql.bind(id.clone());
        sql.push(")");
    }
}

/// What the caller reads of the page; each `unindexed` keeps the planner off that index.
fn readable(
    sql: &mut Sql,
    page: &Page<'_>,
    from: Option<&Reach>,
    (types_unindexed, reach_unindexed): (bool, bool),
) {
    if !page.edge_types.is_empty() {
        sql.push(if types_unindexed {
            " AND +e.edge_type IN ("
        } else {
            " AND e.edge_type IN ("
        });
        sql.list(page.edge_types);
        sql.push(")");
    }
    if let Some(reach) = from {
        sql.push(" AND ");
        reach.clause(sql, "f", reach_unindexed);
    }
}

fn ordered(sql: &mut Sql, page: &Page<'_>) {
    let (column, _, order) = order_of(page);
    sql.push(&format!(" ORDER BY e.{column} {order}, e.id {order}"));
}

fn page_sql(page: &Page<'_>, from: Option<&Reach>) -> Sql {
    let mut sql = Sql::new(&format!("{EDGE_FROM} WHERE 1 = 1"));
    bounds(&mut sql, page);
    readable(&mut sql, page, from, (false, held_to_an_item(page)));
    ordered(&mut sql, page);
    sql
}

/// Each walked edge comes back with whether the caller reads it; only a read one is decoded.
fn window_sql(page: &Page<'_>, from: Option<&Reach>, window: i64) -> Sql {
    let mut sql = Sql::new(
        "SELECT e.seq, e.id, e.from_id, e.to_id, e.edge_type, \
         CASE WHEN (1 = 1",
    );
    readable(&mut sql, page, from, (true, true));
    sql.push(
        ") THEN (SELECT json(held.properties) FROM edges held WHERE held.seq = e.seq) END, \
         e.version, e.created_at, e.updated_at FROM (SELECT e.seq, e.id, e.from_id, e.to_id, \
         e.edge_type, e.version, e.created_at, e.updated_at FROM edges e WHERE 1 = 1",
    );
    bounds(&mut sql, page);
    ordered(&mut sql, page);
    sql.push(" LIMIT ");
    sql.bind(window);
    sql.push(") e JOIN items f ON f.id = e.from_id");
    ordered(&mut sql, page);
    sql
}

fn walk_window(
    tx: &Transaction<'_>,
    page: &Page<'_>,
    from: Option<&Reach>,
    window: i64,
    keeps: impl Fn(&str) -> bool,
) -> Result<(Vec<Edge>, i64)> {
    let sql = window_sql(page, from, window);
    let mut statement = tx.prepare_cached(&sql.text)?;
    let mut found = statement.query(params_from_iter(&sql.values))?;
    let mut kept = Vec::new();
    let mut walked = 0;
    while let Some(row) = found.next()? {
        walked += 1;
        if row.get_ref(5)?.data_type() == rusqlite::types::Type::Null {
            continue;
        }
        let edge = edge_of(row)?;
        if keeps(&edge.edge_type) {
            kept.push(edge);
            if kept.len() as i64 >= page.limit {
                break;
            }
        }
    }
    Ok((kept, walked))
}

/// Every statement `page` may run for this page, as a test reads their cost.
#[cfg(test)]
fn page_statements(page: &Page<'_>, from: Option<&Reach>) -> Vec<Sql> {
    let mut statements = vec![page_sql(page, from)];
    if let Some(window) = window_of(page, from) {
        statements.push(window_sql(page, from, window));
    }
    statements
}

pub(super) fn hosts_out_of_bin(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Vec<(String, String, String)>> {
    let mut statement = tx.prepare_cached(
        "SELECT e.edge_type, h.type, json(h.properties) FROM edges e \
         JOIN items h ON h.id = e.to_id \
         WHERE e.from_id = ?1 AND h.state <> 'trashed' \
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
        "SELECT id, edge_type, from_id, to_id FROM edges WHERE {column} = ?1"
    ))?;
    let found = statement.query_map([id], |row| {
        Ok(Link {
            id: row.get(0)?,
            edge_type: row.get(1)?,
            from: row.get(2)?,
            to: row.get(3)?,
        })
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

impl Graph for Store<'_, '_> {
    type Error = Refusal;

    fn outbound(&self, id: &str) -> Result<Vec<Link>> {
        links(self.tx, "from_id", id)
    }

    fn inbound(&self, id: &str) -> Result<Vec<Link>> {
        links(self.tx, "to_id", id)
    }

    fn triple(
        &self,
        source: &str,
        target: &str,
        edge_type: &str,
        except: Option<&str>,
    ) -> Result<Option<String>> {
        Ok(self
            .tx
            .prepare_cached(
                "SELECT id FROM edges
                  WHERE from_id = ?1 AND to_id = ?2 AND edge_type = ?3
                    AND (?4 IS NULL OR id <> ?4)",
            )?
            .query_row(params![source, target, edge_type, except], |row| row.get(0))
            .optional()?)
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

/// An edge's end, as an export judges the edge.
#[derive(Clone, Debug)]
pub struct End {
    pub seq: i64,
    pub type_id: String,
    pub state: String,
}

/// A page of edges after `after`, in `seq` order, each with its two ends.
pub(super) fn with_ends(
    tx: &Transaction<'_>,
    after: i64,
    limit: i64,
) -> Result<Vec<(Edge, End, End)>> {
    let mut statement = tx.prepare_cached(
        "SELECT e.seq, e.id, e.from_id, e.to_id, e.edge_type, json(e.properties), \
         e.version, e.created_at, e.updated_at, s.seq, s.type, s.state, t.seq, t.type, t.state \
         FROM edges e JOIN items s ON s.id = e.from_id JOIN items t ON t.id = e.to_id \
         WHERE e.seq > ?1 ORDER BY e.seq LIMIT ?2",
    )?;
    let found = statement.query_map([after, limit], |row| {
        Ok((
            edge_of(row)?,
            End {
                seq: row.get(9)?,
                type_id: row.get(10)?,
                state: row.get(11)?,
            },
            End {
                seq: row.get(12)?,
                type_id: row.get(13)?,
                state: row.get(14)?,
            },
        ))
    })?;
    Ok(found.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, StatementStatus, params};

    use super::*;

    const BULK: i64 = 20_000;
    const OWNER_ITEMS: i64 = 2_000;

    fn item(db: &Connection, id: &str, type_id: &str, source: &str) {
        db.execute(
            "INSERT INTO items (id, type, state, tier, source, version, schema_version, \
             occurred_at, created_at, updated_at, last_activity_at, properties) \
             VALUES (?1, ?2, 'active', 'library', ?3, 1, 1, '2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', \
             '2026-01-01T00:00:00.000Z', jsonb('{}'))",
            params![id, type_id, source],
        )
        .unwrap();
    }

    fn edge(db: &Connection, at: i64, from: &str, to: &str, edge_type: &str) -> String {
        let id = format!("edge-{at:06}");
        let stamp = format!(
            "2026-02-01T{:02}:{:02}:{:02}.000Z",
            at / 3600,
            at / 60 % 60,
            at % 60
        );
        db.execute(
            "INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, jsonb('{}'), 1, ?5, ?5)",
            params![id, from, to, edge_type, stamp],
        )
        .unwrap();
        id
    }

    /// The edges a narrow caller reads are the oldest, under many it does not.
    struct Held {
        db: Connection,
        own: Vec<String>,
        notes: Vec<String>,
        references: Vec<String>,
    }

    fn held() -> Held {
        let db = Connection::open_in_memory().unwrap();
        crate::db::migrate::make_all(&db).unwrap();
        let tx = db.unchecked_transaction().unwrap();
        for at in 0..OWNER_ITEMS {
            item(&tx, &format!("owner-{at}"), "acme.ticket", "owner");
        }
        let mut at = 0;
        let mut next = |from: &str, to: &str, edge_type: &str| {
            at += 1;
            edge(&tx, at, from, to, edge_type)
        };
        let mut own = Vec::new();
        let mut notes = Vec::new();
        let mut references = Vec::new();
        for n in 0..20 {
            item(&tx, &format!("own-{n}"), "acme.ticket", "connector");
            own.push(next(&format!("own-{n}"), "owner-0", "mock.bench"));
        }
        for n in 0..5 {
            item(&tx, &format!("note-{n}"), "core.note", "owner");
            notes.push(next(&format!("note-{n}"), "owner-0", "mock.bench"));
        }
        for n in 1..=3 {
            references.push(next("owner-0", &format!("owner-{n}"), "references"));
        }
        for n in 0..BULK {
            let from = format!("owner-{}", n % OWNER_ITEMS);
            let to = format!("owner-{}", 1 + n / OWNER_ITEMS);
            next(&from, &to, "mock.bench");
        }
        tx.commit().unwrap();
        Held {
            db,
            own,
            notes,
            references,
        }
    }

    fn first_page(page_limit: i64, edge_types: &[String]) -> Page<'_> {
        Page {
            from: None,
            to: None,
            edge_types,
            updated_after: None,
            updated_before: None,
            after: None,
            by_change: false,
            limit: page_limit,
        }
    }

    /// The page and the steps every statement it may run took.
    fn read(held: &Held, page: &Page<'_>, from: Option<&Reach>) -> (Vec<String>, i32) {
        let tx = held.db.unchecked_transaction().unwrap();
        let found = super::page(&tx, page, from, |_| true).unwrap();
        let steps = page_statements(page, from)
            .iter()
            .map(|sql| {
                tx.prepare_cached(&sql.text)
                    .unwrap()
                    .get_status(StatementStatus::VmStep)
            })
            .sum();
        let mut ids: Vec<String> = found.into_iter().map(|edge| edge.id).collect();
        ids.sort();
        (ids, steps)
    }

    #[test]
    fn a_narrow_page_reads_by_index_what_its_caller_reads_and_not_the_whole_table() {
        let held = held();
        let none: [String; 0] = [];
        let page = first_page(101, &none);
        // Witness: the owner's page stops at its limit near the newest edge.
        let (whole, whole_steps) = read(&held, &page, None);
        assert_eq!(whole.len(), 101);
        // A walk of the window and the owner's page, far under a walk of the table's 20,000 edges.
        let bound = 40 * WINDOW + i64::from(whole_steps);

        let references = ["references".to_string()];
        let both = ["mock.bench".to_string(), "references".to_string()];
        let last = BULK + 28;
        let newest: Vec<String> = (last - 100..=last)
            .map(|at| format!("edge-{at:06}"))
            .collect();
        let readers: [(&str, Page<'_>, Option<Reach>, &[String]); 4] = [
            (
                "most of the table",
                first_page(101, &both),
                Some(Reach::testing(&["acme.ticket", "core.note"], &[], &[])),
                &newest,
            ),
            (
                "a connector's own items",
                first_page(101, &none),
                Some(Reach::testing_own(&["acme.ticket"], "connector")),
                &held.own,
            ),
            (
                "one edge type",
                first_page(101, &references),
                None,
                &held.references,
            ),
            (
                "one item type",
                first_page(101, &none),
                Some(Reach::testing(&["core.note"], &[], &[])),
                &held.notes,
            ),
        ];
        for (name, page, reach, expected) in readers {
            let (ids, steps) = read(&held, &page, reach.as_ref());
            let mut expected = expected.to_vec();
            expected.sort();
            assert_eq!(ids, expected, "{name}");
            assert!(
                i64::from(steps) < bound,
                "{name}: {steps} steps for {} edges, against {whole_steps} for the owner's page of 101",
                expected.len()
            );
        }
    }
}
