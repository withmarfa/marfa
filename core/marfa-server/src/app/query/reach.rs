use marfa_rules::catalog::Catalog as Rules;

use rusqlite::Transaction;

use super::compile::Sql;
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::items::Reader;
use crate::app::refusal::Result;

/// A type in no list is left out, so a type written after this snapshot cannot pass.
#[derive(Clone, Debug)]
pub struct Reach {
    open: Vec<String>,
    held: Vec<String>,
    sources: Vec<String>,
    /// Types a plugin's connector key reads only under its own source, through its mapping.
    own: Vec<String>,
    own_source: String,
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

    /// As `of`, adding a connector key's mapped types for its own items alone.
    pub fn of_own(read: &Reader<'_, '_>) -> Result<Reach> {
        read.caller.require_reach()?;
        Reach::within_own(read.tx, &read.caller, &read.catalog)
    }

    pub fn within_own(tx: &Transaction<'_>, caller: &Caller, catalog: &Catalog) -> Result<Reach> {
        Reach::build(tx, caller, catalog, true)
    }

    pub fn within(tx: &Transaction<'_>, caller: &Caller, catalog: &Catalog) -> Result<Reach> {
        Reach::build(tx, caller, catalog, false)
    }

    fn build(tx: &Transaction<'_>, caller: &Caller, catalog: &Catalog, own: bool) -> Result<Reach> {
        let present = present(tx)?;
        let own_source = caller
            .key()
            .map(|key| key.source.clone())
            .unwrap_or_default();
        let mut reach = Reach {
            open: Vec::new(),
            held: Vec::new(),
            sources: Vec::new(),
            own: Vec::new(),
            own_source,
            whole: true,
        };
        for type_id in present {
            if !caller.may_read_type(&type_id) {
                reach.whole = false;
                if own
                    && caller.maps_onto(&type_id)
                    && caller
                        .levers()?
                        .lists(&catalog.rules, &type_id, &reach.own_source)
                {
                    reach.own.push(type_id);
                }
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
        self.open.is_empty() && self.held.is_empty() && self.own.is_empty()
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
            own: kept(&self.own),
            own_source: self.own_source.clone(),
            whole: false,
        }
    }

    /// The one type this reach reads whole, when it reads no other.
    pub fn only_type(&self) -> Option<&str> {
        match (
            self.open.as_slice(),
            self.held.is_empty() && self.own.is_empty(),
        ) {
            ([only], true) => Some(only),
            _ => None,
        }
    }

    /// Whether a type here is held to a source. `OR` across the lists
    /// takes the type index out of order, so such a reach walks the order.
    pub fn narrows_by_source(&self) -> bool {
        !self.held.is_empty() || (!self.own.is_empty() && !self.open.is_empty())
    }

    fn own_alone(&self) -> bool {
        self.open.is_empty() && self.held.is_empty() && !self.own.is_empty()
    }

    /// `unindexed` keeps the planner off the type index, for a query an order index serves better.
    pub fn clause(&self, sql: &mut Sql, alias: &str, unindexed: bool) {
        let mark = if unindexed { "+" } else { "" };
        if self.own_alone() {
            sql.push(&format!("({mark}{alias}.type IN ("));
            sql.list(&self.own);
            sql.push(&format!(") AND {mark}{alias}.source = "));
            sql.bind(self.own_source.clone());
            sql.push(")");
            return;
        }
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
        if !self.own.is_empty() {
            sql.push(&format!(" OR ({mark}{alias}.type IN ("));
            sql.list(&self.own);
            sql.push(&format!(") AND +{alias}.source = "));
            sql.bind(self.own_source.clone());
            sql.push(")");
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
            own: Vec::new(),
            own_source: String::new(),
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

pub fn keeps_type(rules: &Rules, named: &[String], hidden: bool, type_id: &str) -> bool {
    if named.is_empty() {
        return hidden || !crate::app::items::is_hidden(type_id);
    }
    named.iter().any(|entry| {
        if hidden {
            rules.matches(entry, type_id)
        } else {
            marfa_rules::folder::takes_type(rules, entry, type_id)
        }
    })
}
