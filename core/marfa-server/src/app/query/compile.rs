use marfa_rules::filter::sql::{self, Bind, Items, Relation, Sink};
use marfa_rules::filter::{Expression, Term};
use rusqlite::types::Value;
use serde_json::{Value as Json, json};

use super::reach::{Reach, keeps_type};
use crate::app::access::Level;
use crate::app::catalog::Catalog;
use crate::app::items::Reader;
use crate::app::items::write::ruled;
use crate::app::refusal::Result;

const PARENT_OF: &str = "parent-of";

#[derive(Clone, Debug, Default)]
pub struct Sql {
    pub text: String,
    pub values: Vec<Value>,
}

impl Sql {
    pub fn new(text: &str) -> Sql {
        Sql {
            text: text.to_string(),
            values: Vec::new(),
        }
    }

    pub fn push(&mut self, text: &str) {
        self.text.push_str(text);
    }

    pub fn bind(&mut self, value: impl Into<Value>) {
        self.text.push('?');
        self.values.push(value.into());
    }

    pub fn list(&mut self, entries: &[impl AsRef<str>]) {
        for (at, entry) in entries.iter().enumerate() {
            if at > 0 {
                self.text.push_str(", ");
            }
            self.bind(entry.as_ref().to_string());
        }
    }

    pub fn append(&mut self, other: &Sql) {
        self.text.push_str(&other.text);
        self.values.extend(other.values.iter().cloned());
    }
}

impl Sink for Sql {
    fn push(&mut self, text: &str) {
        Sql::push(self, text);
    }

    fn bind(&mut self, value: Bind) {
        Sql::bind(self, value_of(value));
    }
}

fn value_of(bind: Bind) -> Value {
    match bind {
        Bind::Null => Value::Null,
        Bind::Real(number) => Value::Real(number),
        Bind::Text(text) => Value::Text(text),
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum States {
    #[default]
    Every,
    Named(Vec<String>),
}

#[derive(Clone, Debug)]
pub struct Filter {
    pub text: String,
    pub expression: Expression,
}

#[derive(Clone, Debug, Default)]
pub struct Ask {
    pub types: Vec<String>,
    pub system: bool,
    pub states: States,
    pub source: Option<String>,
    pub tier: Option<String>,
    pub tags: Vec<String>,
    pub filter: Option<Filter>,
    pub beneath: Option<String>,
    pub occurred_after: Option<String>,
    pub occurred_before: Option<String>,
    pub updated_after: Option<String>,
    pub updated_before: Option<String>,
}

impl Ask {
    /// Whether a type, a source or a state with no active rows narrows this ask before any row is
    /// read; anything else reads fewer rows by one walk of its order than by a walk for each type.
    pub(super) fn leaves_few(&self) -> bool {
        let rare = matches!(&self.states, States::Named(states)
            if states.iter().all(|state| state != "active"));
        !self.types.is_empty() || self.source.is_some() || rare
    }

    pub fn scope(&self) -> Json {
        let sorted = |list: &[String]| {
            let mut sorted = list.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            sorted
        };
        let states = match &self.states {
            States::Every => None,
            States::Named(states) => Some(sorted(states)),
        };
        json!([
            sorted(&self.types),
            self.system,
            states,
            self.source,
            self.tier,
            sorted(&self.tags),
            self.filter.as_ref().map(|filter| filter.text.as_str()),
            self.beneath,
            self.occurred_after,
            self.occurred_before,
            self.updated_after,
            self.updated_before,
        ])
    }
}

pub fn judge(read: &Reader<'_, '_>, ask: &Ask) -> Result<()> {
    for entry in &ask.types {
        judge_type(read, entry)?;
    }
    judge_terms(read, ask)
}

/// A type the catalog lacks is unknown; one the caller reads neither itself nor below it is not permitted.
pub(crate) fn judge_type(read: &Reader<'_, '_>, entry: &str) -> Result<()> {
    let rules = &read.catalog.rules;
    marfa_rules::query::refuse_unknown_type(rules, Some(entry)).map_err(ruled)?;
    if entry.ends_with(".*")
        || read.caller.may_read_type(entry)
        || rules
            .descendants(entry)
            .any(|below| read.caller.may_read_type(below))
    {
        return Ok(());
    }
    read.caller.require_type(entry, Level::Read)
}

pub fn judge_terms(read: &Reader<'_, '_>, ask: &Ask) -> Result<()> {
    if let Some(filter) = &ask.filter {
        for condition in &filter.expression.conditions {
            if let Term::Edge { edge_type, .. } = &condition.term {
                read.caller.require_edge(edge_type, Level::Read)?;
            }
        }
    }
    if ask.beneath.is_some() {
        read.caller.require_edge(PARENT_OF, Level::Read)?;
    }
    Ok(())
}

pub fn selection(reach: &Reach, ask: &Ask, catalog: &Catalog, walked: bool) -> Result<Sql> {
    let rules = &catalog.rules;
    let rows = reach.narrowed(|type_id| keeps_type(rules, &ask.types, ask.system, type_id));
    let mut sql = Sql::default();
    let by_type = ask.leaves_few() && !walked && !rows.narrows_by_source();
    rows.clause(&mut sql, "i", !by_type);
    if let States::Named(states) = &ask.states {
        sql.push(" AND i.state IN (");
        sql.list(states);
        sql.push(")");
    }
    if let Some(source) = &ask.source {
        sql.push(if walked {
            " AND +i.source = "
        } else {
            " AND i.source = "
        });
        sql.bind(source.clone());
    }
    if let Some(tier) = &ask.tier {
        sql.push(" AND i.tier = ");
        sql.bind(tier.clone());
    }
    for tag in &ask.tags {
        sql.push(" AND EXISTS (SELECT 1 FROM item_tags t WHERE t.item_seq = i.seq AND t.tag = ");
        sql.bind(tag.clone());
        sql.push(")");
    }
    if let Some(filter) = &ask.filter {
        sql.push(" AND ");
        expression(&mut sql, &filter.expression, reach, catalog)?;
    }
    if let Some(root) = &ask.beneath {
        sql.push(" AND ");
        beneath(&mut sql, root, reach);
    }
    for (column, operator, bound) in [
        ("occurred_at", ">", &ask.occurred_after),
        ("occurred_at", "<", &ask.occurred_before),
        ("updated_at", ">=", &ask.updated_after),
        ("updated_at", "<", &ask.updated_before),
    ] {
        if let Some(bound) = bound {
            sql.push(&format!(" AND i.{column} {operator} "));
            sql.bind(bound.clone());
        }
    }
    Ok(sql)
}

/// The walk leaves only a row in `reach`, so a row the caller cannot read joins no path, and
/// `UNION` ends it on a cycle.
fn beneath(sql: &mut Sql, root: &str, reach: &Reach) {
    sql.push("i.id IN (WITH RECURSIVE beneath(id) AS (SELECT ");
    sql.bind(root.to_string());
    sql.push(
        " UNION SELECT e.target_id FROM edges e JOIN beneath b ON e.source_id = b.id \
         JOIN items s ON s.id = e.source_id WHERE e.edge_type = ",
    );
    sql.bind(PARENT_OF.to_string());
    sql.push(" AND ");
    reach.clause(sql, "s", false);
    sql.push(") SELECT id FROM beneath)");
}

fn expression(
    sql: &mut Sql,
    expression: &Expression,
    reach: &Reach,
    catalog: &Catalog,
) -> Result<()> {
    let items = Items {
        alias: "i",
        unreadable_properties: false,
    };
    sql::item_filter(sql, expression, &items, &catalog.rules, |sql, relation| {
        match relation {
            Relation::Tag(value) => {
                // `+` takes the column's text affinity off, so a number never
                // matches a tag spelled like it.
                sql.push(
                    "EXISTS (SELECT 1 FROM item_tags t WHERE t.item_seq = i.seq AND +t.tag = ",
                );
                sql.bind(value_of(sql::bound(value)));
                sql.push(")");
            }
            Relation::Tags { present } => {
                sql.push(if present { "" } else { "NOT " });
                sql.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_seq = i.seq)");
            }
            Relation::Edge {
                edge_type,
                backref,
                negated,
                to,
            } => {
                sql.push(if negated { "NOT EXISTS (" } else { "EXISTS (" });
                if backref {
                    sql.push(
                        "SELECT 1 FROM edges e JOIN items s ON s.id = e.source_id \
                         WHERE e.target_id = i.id AND e.edge_type = ",
                    );
                } else {
                    sql.push("SELECT 1 FROM edges e WHERE e.source_id = i.id AND e.edge_type = ");
                }
                sql.bind(edge_type.to_string());
                if let Some(value) = to {
                    sql.push(if backref {
                        " AND e.source_id = "
                    } else {
                        " AND e.target_id = "
                    });
                    sql.bind(value_of(sql::bound(value)));
                }
                if backref {
                    sql.push(" AND ");
                    reach.clause(sql, "s", false);
                }
                sql.push(")");
            }
            Relation::Part { selected } => {
                sql.push(if selected { "" } else { "NOT " });
                part(sql, catalog);
            }
        }
        Ok(())
    })
    .map_err(ruled)
}

/// Judged over every host, whatever the caller reads, because the answer names none of them.
fn part(sql: &mut Sql, catalog: &Catalog) {
    sql.push(
        "(i.state <> 'trashed' AND EXISTS (SELECT 1 FROM edges e \
         JOIN items h ON h.id = e.target_id WHERE e.source_id = i.id AND e.edge_type IN (",
    );
    sql.list(&catalog.with_hosts_types());
    sql.push(") AND h.state <> 'trashed'))");
}
