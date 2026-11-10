use marfa_rules::catalog::StatusField;
use marfa_rules::filter::{Compare, Condition, Expression, Literal, Op, Term, system_literal};
use marfa_rules::query::escape_like;
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
    let statuses = if expression.reads_status() {
        catalog.rules.status_fields()
    } else {
        Vec::new()
    };
    let joiner = if expression.any { " OR " } else { " AND " };
    sql.push("(");
    for (at, one) in expression.conditions.iter().enumerate() {
        if at > 0 {
            sql.push(joiner);
        }
        condition(sql, one, reach, catalog, &statuses)?;
    }
    sql.push(")");
    Ok(())
}

fn condition(
    sql: &mut Sql,
    condition: &Condition,
    reach: &Reach,
    catalog: &Catalog,
    statuses: &[StatusField],
) -> Result<()> {
    let value = &condition.value;
    match &condition.term {
        Term::System { column, compare } => {
            let literal = system_literal(column, *compare, value).map_err(ruled)?;
            compared(sql, &Sql::new(&format!("i.{column}")), *compare, &literal);
        }
        Term::Property { name, op } => property(sql, "i.properties", name, *op, value),
        Term::Entry { field, member } => entry(sql, field, member, value),
        Term::TagHeld => {
            // `+` takes the column's text affinity off, so a number never
            // matches a tag spelled like it.
            sql.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_seq = i.seq AND +t.tag = ");
            sql.bind(bound(value));
            sql.push(")");
        }
        Term::TagsPresent(present) => {
            sql.push(if *present { "" } else { "NOT " });
            sql.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_seq = i.seq)");
        }
        Term::Edge {
            edge_type,
            backref,
            negated,
            to_item,
        } => {
            sql.push(if *negated { "NOT EXISTS (" } else { "EXISTS (" });
            if *backref {
                sql.push(
                    "SELECT 1 FROM edges e JOIN items s ON s.id = e.source_id \
                     WHERE e.target_id = i.id AND e.edge_type = ",
                );
            } else {
                sql.push("SELECT 1 FROM edges e WHERE e.source_id = i.id AND e.edge_type = ");
            }
            sql.bind(edge_type.clone());
            if *to_item {
                sql.push(if *backref {
                    " AND e.source_id = "
                } else {
                    " AND e.target_id = "
                });
                sql.bind(bound(value));
            }
            if *backref {
                sql.push(" AND ");
                reach.clause(sql, "s", false);
            }
            sql.push(")");
        }
        Term::StatusGroup(op) => status_group(sql, *op, value, statuses),
        Term::Part(compare) => {
            let selected = matches!(value, Literal::Bool(true)) == (*compare == Compare::Eq);
            sql.push(if selected { "" } else { "NOT " });
            part(sql, catalog);
        }
    }
    Ok(())
}

fn extract(source: &str, name: &str) -> Sql {
    let mut sql = Sql::new(&format!("json_extract({source}, "));
    sql.bind(format!("$.{name}"));
    sql.push(")");
    sql
}

/// A condition on member `name` of the JSON object in the column `source`.
fn property(sql: &mut Sql, source: &str, name: &str, op: Op, value: &Literal) {
    let mut kind = Sql::new(&format!("json_type({source}, "));
    kind.bind(format!("$.{name}"));
    kind.push(")");
    held_property(sql, &extract(source, name), &kind, op, value);
}

/// A condition on the value `held`, whose JSON type is `kind`.
pub(crate) fn held_property(sql: &mut Sql, held: &Sql, kind: &Sql, op: Op, value: &Literal) {
    match op {
        Op::Compare(compare @ (Compare::Eq | Compare::Neq))
            if matches!(value, Literal::Number(_)) =>
        {
            let mut number = Sql::new("CASE WHEN ");
            number.append(kind);
            number.push(" IN ('integer', 'real') THEN CAST(");
            number.append(held);
            number.push(" AS REAL) ELSE ");
            number.append(held);
            number.push(" END");
            compared(sql, &number, compare, value);
        }
        Op::Compare(compare @ (Compare::Gt | Compare::Gte | Compare::Lt | Compare::Lte))
            if matches!(value, Literal::Number(_)) =>
        {
            let mut number = Sql::new("CAST(");
            number.append(held);
            number.push(" AS REAL)");
            compared(sql, &number, compare, value);
        }
        Op::Compare(compare) => compared(sql, held, compare, value),
        Op::Exists => {
            sql.append(held);
            sql.push(" IS NOT NULL");
        }
        Op::NotExists => {
            sql.append(held);
            sql.push(" IS NULL");
        }
    }
}

/// `CASE` keeps `json_extract` off an entry that is not an object.
fn entry(sql: &mut Sql, field: &str, member: &str, value: &Literal) {
    let list = format!("$.{field}");
    let path = format!("$.{member}");
    sql.push("EXISTS (SELECT 1 FROM json_each(i.properties, ");
    sql.bind(list.clone());
    sql.push(") AS entry WHERE json_type(i.properties, ");
    sql.bind(list);
    sql.push(") = 'array' AND ");
    if matches!(value, Literal::Number(_)) {
        sql.push("CASE WHEN entry.type <> 'object' THEN NULL WHEN json_type(entry.value, ");
        sql.bind(path.clone());
        sql.push(") IN ('integer', 'real') THEN CAST(json_extract(entry.value, ");
        sql.bind(path.clone());
        sql.push(") AS REAL) ELSE json_extract(entry.value, ");
        sql.bind(path);
        sql.push(") END");
    } else {
        sql.push("CASE WHEN entry.type = 'object' THEN json_extract(entry.value, ");
        sql.bind(path);
        sql.push(") END");
    }
    sql.push(" = ");
    sql.bind(bound(value));
    sql.push(")");
}

/// Every number, a boolean included, binds as a REAL, as the working copy binds it: bound otherwise,
/// a condition answers one set of rows on a device and another here.
fn bound(literal: &Literal) -> Value {
    match literal {
        Literal::Text(text) => Value::Text(text.clone()),
        Literal::Number(number) => Value::Real(*number),
        Literal::Bool(flag) => Value::Real(if *flag { 1.0 } else { 0.0 }),
        Literal::Null => Value::Null,
    }
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

/// A row whose type has no status field, or whose value is no word its type declares, is in no
/// group, so `eq` and `neq` both pass it by and `not_exists` takes it.
fn status_group(sql: &mut Sql, op: Op, value: &Literal, statuses: &[StatusField]) {
    let wanted = |group: &str| match (op, value) {
        (Op::Compare(Compare::Eq), Literal::Text(asked)) => group == asked,
        (Op::Compare(Compare::Neq), Literal::Text(asked)) => group != asked,
        _ => true,
    };
    let mut selections: Vec<(&str, Vec<&str>, Vec<&str>)> = Vec::new();
    for status in statuses {
        let words: Vec<&str> = status
            .words
            .iter()
            .filter(|(_, group)| wanted(group))
            .map(|(word, _)| word.as_str())
            .collect();
        if words.is_empty() {
            continue;
        }
        match selections
            .iter_mut()
            .find(|(name, selected, _)| *name == status.name && *selected == words)
        {
            Some((_, _, types)) => types.push(&status.type_id),
            None => selections.push((&status.name, words, vec![&status.type_id])),
        }
    }
    if op == Op::NotExists {
        sql.push("NOT ");
    }
    if selections.is_empty() {
        sql.push("0");
        return;
    }
    // `IFNULL`, since an absent value compares as unknown, and `NOT` an
    // unknown would pass the row by rather than take it.
    sql.push("IFNULL((");
    for (at, (name, words, types)) in selections.iter().enumerate() {
        if at > 0 {
            sql.push(" OR ");
        }
        sql.push("(i.type IN (");
        sql.list(types);
        sql.push(") AND json_extract(i.properties, ");
        sql.bind(format!("$.{}", Json::String((*name).to_string())));
        sql.push(") IN (");
        sql.list(words);
        sql.push("))");
    }
    sql.push("), 0)");
}

pub(crate) fn compared(sql: &mut Sql, held: &Sql, compare: Compare, value: &Literal) {
    sql.append(held);
    let operator = match compare {
        Compare::Eq => " = ",
        Compare::Neq => " != ",
        Compare::Gt => " > ",
        Compare::Gte => " >= ",
        Compare::Lt => " < ",
        Compare::Lte => " <= ",
        Compare::Contains | Compare::StartsWith => " LIKE ",
    };
    sql.push(operator);
    match compare {
        Compare::Contains => sql.bind(format!("%{}%", escape_like(&value.text()))),
        Compare::StartsWith => sql.bind(format!("{}%", escape_like(&value.text()))),
        _ => {
            sql.bind(bound(value));
            return;
        }
    }
    sql.push(" ESCAPE '\\'");
}
