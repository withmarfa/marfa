use std::collections::HashMap;

use marfa_rules::catalog::STATUS_GROUPS;
use marfa_rules::error::RuleError;
use marfa_rules::filter::{
    self,
    sql::{self, Items},
};
use rusqlite::params_from_iter;

use super::compile::Sql;
use super::reach::{Reach, keeps_type};
use crate::app::App;
use crate::app::access::{Caller, Level};
use crate::app::items::write::ruled;
use crate::app::items::{Reader, reading};
use crate::app::refusal::Result;
use crate::app::tables;

/// What a count counts for each item.
#[derive(Clone, Debug)]
pub enum Counted {
    /// The items an edge of the type leaves the item for: `backref[<type>]`.
    Backref(String),
    /// The items an edge of the type arrives at the item from: `edge[<type>]`.
    Edge(String),
    /// The rows the item holds in the table.
    Table(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Count {
    pub id: String,
    pub total: i64,
    /// The counted items in each of `STATUS_GROUPS`, in that order; none for a table's rows.
    pub groups: Option<[i64; 4]>,
}

/// The counts of `ids` in order. Only active items count, as a listing that names no state lists them.
pub async fn counts(
    app: &App,
    caller: &Caller,
    ids: Vec<String>,
    counted: Counted,
) -> Result<Vec<Count>> {
    reading(app, caller, move |read| {
        read.caller.require_reach()?;
        match &counted {
            Counted::Table(name) => {
                let totals = tables::row_counts(read, &ids, name)?;
                Ok(ids
                    .into_iter()
                    .zip(totals)
                    .map(|(id, total)| Count {
                        id,
                        total,
                        groups: None,
                    })
                    .collect())
            }
            Counted::Backref(edge_type) => linked(read, ids, edge_type, true),
            Counted::Edge(edge_type) => linked(read, ids, edge_type, false),
        }
    })
    .await
}

/// A group's own predicate is the `status_group` filter's, so a word's group is resolved once.
fn in_group(sql: &mut Sql, read: &Reader<'_, '_>, group: &str) -> Result<()> {
    let expression = filter::parse(&format!("status_group eq \"{group}\"")).map_err(ruled)?;
    let items = Items {
        alias: "i",
        unreadable_properties: false,
    };
    sql::item_filter(sql, &expression, &items, &read.catalog.rules, |_, _| {
        Err(RuleError::validation("A status group names no relation."))
    })
    .map_err(ruled)
}

/// Joined from the edges so a request costs what its anchors link, not what the instance holds.
/// Each filter is the listing's own, so a count and its listing cannot differ.
fn linked(
    read: &Reader<'_, '_>,
    ids: Vec<String>,
    edge_type: &str,
    backref: bool,
) -> Result<Vec<Count>> {
    read.caller.require_edge(edge_type, Level::Read)?;
    let reach = Reach::of(read)?;
    let counted = reach.narrowed(|type_id| keeps_type(&read.catalog.rules, &[], false, type_id));
    let mut found: HashMap<String, (i64, [i64; 4])> = HashMap::new();
    if !ids.is_empty() && !counted.is_empty() {
        let (anchor, other) = if backref {
            ("from_id", "to_id")
        } else {
            ("to_id", "from_id")
        };
        let mut sql = Sql::new(&format!("SELECT e.{anchor}, COUNT(*)"));
        for group in STATUS_GROUPS {
            sql.push(", SUM(CASE WHEN ");
            in_group(&mut sql, read, group)?;
            sql.push(" THEN 1 ELSE 0 END)");
        }
        sql.push(&format!(
            " FROM edges e CROSS JOIN items i ON i.id = e.{other}"
        ));
        if backref {
            sql.push(" CROSS JOIN items a ON a.id = e.from_id");
        }
        sql.push(" WHERE e.edge_type = ");
        sql.bind(edge_type.to_string());
        sql.push(&format!(" AND e.{anchor} IN ("));
        sql.list(&ids);
        sql.push(") AND +i.state = 'active' AND ");
        counted.clause(&mut sql, "i", true);
        if backref {
            sql.push(" AND ");
            reach.clause(&mut sql, "a", true);
        }
        sql.push(&format!(" GROUP BY e.{anchor}"));
        let mut statement = read.tx.prepare_cached(&sql.text)?;
        let rows = statement.query_map(params_from_iter(&sql.values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                [row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?],
            ))
        })?;
        for row in rows {
            let (id, total, groups) = row?;
            found.insert(id, (total, groups));
        }
    }
    Ok(ids
        .into_iter()
        .map(|id| {
            let (total, groups) = found.get(&id).copied().unwrap_or((0, [0; 4]));
            Count {
                id,
                total,
                groups: Some(groups),
            }
        })
        .collect())
}
