//! The events a window reads, and the `parent-of` edges that bind a moved occurrence to its series.

use rusqlite::types::Value as Sql;
use serde_json::Value;

use super::compile::{Ask, States, judge_type, selection};
use super::reach::Reach;
use crate::app::items::Reader;
use crate::app::refusal::Result;

const EVENT_TYPE: &str = "core.event";
const PARENT_OF: &str = "parent-of";
const EDGE_BATCH: usize = 500;

/// How an event states its `recurrence`.
#[derive(Debug)]
pub enum Recurrence {
    Absent,
    Entries(Vec<Value>),
    NotAList,
}

#[derive(Debug)]
pub struct Event {
    pub seq: i64,
    pub id: String,
    pub type_id: String,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub duration: Option<f64>,
    pub all_day: bool,
    pub timezone: Option<String>,
    pub recurrence: Recurrence,
    pub original_starts_at: Option<String>,
}

fn text(path: &str) -> String {
    format!(
        "CASE WHEN json_type(i.properties, '{path}') = 'text' THEN json_extract(i.properties, '{path}') END"
    )
}

/// Every active event the caller reads: a `type` filter narrows the answer, not the matching.
pub(crate) fn events(read: &Reader<'_, '_>, named: Option<&str>) -> Result<Vec<Event>> {
    let reach = Reach::of(read)?;
    if let Some(named) = named {
        judge_type(read, named)?;
    }
    let ask = Ask {
        types: vec![EVENT_TYPE.to_string()],
        states: States::Named(vec!["active".to_string()]),
        ..Ask::default()
    };
    let mut sql = super::compile::Sql::new(&format!(
        "SELECT i.seq, i.id, i.type, {}, {}, \
         CASE WHEN json_type(i.properties, '$.duration') IN ('integer', 'real') \
              THEN json_extract(i.properties, '$.duration') END, \
         COALESCE(json_type(i.properties, '$.all_day') = 'true', 0), {}, \
         json_type(i.properties, '$.recurrence'), json_extract(i.properties, '$.recurrence'), {} \
         FROM items i WHERE ",
        text("$.starts_at"),
        text("$.ends_at"),
        text("$.timezone"),
        text("$.original_starts_at"),
    ));
    sql.append(&selection(&reach, &ask, &read.catalog, false)?);
    sql.push(" ORDER BY i.seq");
    let mut statement = read.tx.prepare_cached(&sql.text)?;
    let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
        let kind: Option<String> = row.get(8)?;
        let recurrence = match (kind.as_deref(), row.get::<_, Sql>(9)?) {
            (None | Some("null"), _) => Recurrence::Absent,
            (Some("array"), Sql::Text(entries)) => match serde_json::from_str(&entries) {
                Ok(Value::Array(entries)) => Recurrence::Entries(entries),
                _ => Recurrence::NotAList,
            },
            _ => Recurrence::NotAList,
        };
        Ok(Event {
            seq: row.get(0)?,
            id: row.get(1)?,
            type_id: row.get(2)?,
            starts_at: row.get(3)?,
            ends_at: row.get(4)?,
            duration: row.get(5)?,
            all_day: row.get(6)?,
            timezone: row.get(7)?,
            recurrence,
            original_starts_at: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The `(source, target)` of every `parent-of` edge into one of `targets`, oldest edge first.
pub(crate) fn parents(read: &Reader<'_, '_>, targets: &[&str]) -> Result<Vec<(String, String)>> {
    let mut found: Vec<(i64, String, String)> = Vec::new();
    for batch in targets.chunks(EDGE_BATCH) {
        let mut sql = super::compile::Sql::new(
            "SELECT e.seq, e.source_id, e.target_id FROM edges e WHERE e.edge_type = ",
        );
        sql.bind(PARENT_OF.to_string());
        sql.push(" AND e.target_id IN (");
        sql.list(batch);
        sql.push(")");
        let mut statement = read.tx.prepare_cached(&sql.text)?;
        let rows = statement.query_map(rusqlite::params_from_iter(&sql.values), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            found.push(row?);
        }
    }
    found.sort_by_key(|(seq, _, _)| *seq);
    Ok(found
        .into_iter()
        .map(|(_, source, target)| (source, target))
        .collect())
}
