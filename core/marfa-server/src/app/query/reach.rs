use marfa_rules::catalog::Catalog as Rules;

use rusqlite::Transaction;

use super::compile::Sql;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::Reader;
use crate::app::refusal::Result;

/// A type in neither list is left out, so a type written after this snapshot cannot pass.
#[derive(Clone, Debug)]
pub struct Reach {
    open: Vec<String>,
    held: Vec<String>,
    sources: Vec<String>,
    whole: bool,
}

const PRESENT_TYPES: &str = "WITH RECURSIVE present(name) AS (
        SELECT MIN(type) FROM items
        UNION ALL
        SELECT (SELECT MIN(type) FROM items WHERE type > present.name)
        FROM present WHERE present.name IS NOT NULL
    ) SELECT name FROM present WHERE name IS NOT NULL";

impl Reach {
    pub fn of(read: &Reader<'_, '_>) -> Result<Reach> {
        read.caller.require_reach()?;
        Reach::held(read)
    }

    pub fn held(read: &Reader<'_, '_>) -> Result<Reach> {
        Reach::within(read.tx, &read.caller, &read.catalog)
    }

    pub fn within(tx: &Transaction<'_>, caller: &Caller, catalog: &Catalog) -> Result<Reach> {
        let present = present(tx)?;
        let mut reach = Reach {
            open: Vec::new(),
            held: Vec::new(),
            sources: Vec::new(),
            whole: true,
        };
        for type_id in present {
            if !caller.may_read_type(&type_id) {
                reach.whole = false;
                continue;
            }
            match caller.levers()?.listed_sources(&catalog.rules, &type_id) {
                None => reach.open.push(type_id),
                Some(sources) => {
                    reach.sources = sources.to_vec();
                    reach.held.push(type_id);
                    reach.whole = false;
                }
            }
        }
        Ok(reach)
    }

    pub fn is_empty(&self) -> bool {
        self.open.is_empty() && self.held.is_empty()
    }

    /// Whether every item in the database is within reach.
    pub fn is_whole(&self) -> bool {
        self.whole
    }

    pub fn narrowed(&self, keep: impl Fn(&str) -> bool) -> Reach {
        let kept = |types: &[String]| {
            types
                .iter()
                .filter(|type_id| keep(type_id))
                .cloned()
                .collect()
        };
        Reach {
            open: kept(&self.open),
            held: kept(&self.held),
            sources: self.sources.clone(),
            whole: false,
        }
    }

    /// Whether a type here is held to `sources`. `OR` across the two lists
    /// takes the type index out of order, so such a reach walks the order.
    pub fn narrows_by_source(&self) -> bool {
        !self.held.is_empty()
    }

    /// `unindexed` keeps the planner off the type index, for a query an order index serves better.
    pub fn clause(&self, sql: &mut Sql, alias: &str, unindexed: bool) {
        let mark = if unindexed { "+" } else { "" };
        sql.push(&format!("({mark}{alias}.type IN ("));
        sql.list(&self.open);
        sql.push(")");
        if !self.held.is_empty() {
            sql.push(&format!(" OR ({mark}{alias}.type IN ("));
            sql.list(&self.held);
            sql.push(&format!(") AND +{alias}.source IN ("));
            sql.list(&self.sources);
            sql.push("))");
        }
        sql.push(")");
    }

    #[cfg(test)]
    pub fn testing(open: &[&str], held: &[&str], sources: &[&str]) -> Reach {
        let owned = |list: &[&str]| list.iter().map(ToString::to_string).collect();
        Reach {
            open: owned(open),
            held: owned(held),
            sources: owned(sources),
            whole: false,
        }
    }
}

fn present(tx: &Transaction<'_>) -> Result<Vec<String>> {
    Ok(tx
        .prepare_cached(PRESENT_TYPES)?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The types of held items `caller` may read, or `None` where it may read every one.
pub fn readable_types(tx: &Transaction<'_>, caller: &Caller) -> Result<Option<Vec<String>>> {
    let present = present(tx)?;
    let readable: Vec<String> = present
        .iter()
        .filter(|type_id| caller.may_read_type(type_id))
        .cloned()
        .collect();
    Ok((readable.len() < present.len()).then_some(readable))
}

pub fn keeps_type(rules: &Rules, named: &[String], system: bool, type_id: &str) -> bool {
    if named.is_empty() {
        return system || !crate::app::items::is_system(type_id);
    }
    named.iter().any(|entry| rules.matches(entry, type_id))
        && (system
            || !crate::app::items::is_system(type_id)
            || named
                .iter()
                .any(|entry| crate::app::items::is_system(entry)))
}
