//! The SQLite a parsed filter, a table filter and a table total compile to, written once for the
//! server and the working copy. A caller names what its storage differs in: the alias of the item
//! table, whether `properties` may hold text that is not JSON, and how a row's columns are read.
//! The text is written through a [`Sink`], so this module holds no statement and no engine.

use serde_json::{Map, Value};

use super::{Compare, Condition, Expression, Literal, Op, Term, parse_rows, system_literal};
use crate::catalog::{Catalog, StatusField, api_name};
use crate::error::{Result, RuleError};
use crate::query::escape_like;

/// A value a compiled statement binds to a `?`.
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Null,
    Real(f64),
    Text(String),
}

/// Where compiled SQL goes: its text, and the values its `?` marks bind in order.
pub trait Sink {
    fn push(&mut self, text: &str);
    /// Writes a `?` and keeps `value` for it.
    fn bind(&mut self, value: Bind);
}

/// What an item filter's storage differs in.
#[derive(Clone, Copy, Debug)]
pub struct Items<'a> {
    /// The alias of the table holding the items.
    pub alias: &'a str,
    /// Whether `properties` may hold text that is not JSON, which SQLite raises on and a guard must keep from the whole query.
    pub unreadable_properties: bool,
}

impl Items<'_> {
    fn properties(&self) -> String {
        format!("{}.properties", self.alias)
    }

    /// `CASE`, not `AND`, because SQLite promises no order of evaluation for `AND`.
    fn guarded<S: Sink>(&self, out: &mut S, inner: impl FnOnce(&mut S)) {
        if !self.unreadable_properties {
            return inner(out);
        }
        out.push(&format!(
            "CASE WHEN json_valid({}) THEN (",
            self.properties()
        ));
        inner(out);
        out.push(") ELSE 0 END");
    }
}

/// A term of an item filter that reads a relation, which each storage writes in its own tables.
#[derive(Clone, Copy, Debug)]
pub enum Relation<'a> {
    /// The item holds this tag.
    Tag(&'a Literal),
    Tags {
        present: bool,
    },
    Edge {
        edge_type: &'a str,
        backref: bool,
        negated: bool,
        /// The item at the far end, when the term names one.
        to: Option<&'a Literal>,
    },
    /// Whether the item is selected as a part of a host, rather than not.
    Part {
        selected: bool,
    },
}

/// Every number, a boolean included, binds as a REAL. It matters against a text column, whose
/// affinity turns `5` into `'5.0'` rather than `'5'`: bound otherwise, a condition answers one set
/// of rows on a device and another on the server.
pub fn bound(literal: &Literal) -> Bind {
    match literal {
        Literal::Text(text) => Bind::Text(text.clone()),
        Literal::Number(number) => Bind::Real(*number),
        Literal::Bool(flag) => Bind::Real(if *flag { 1.0 } else { 0.0 }),
        Literal::Null => Bind::Null,
    }
}

/// Binds each entry, with `, ` between.
pub fn list<S: Sink>(out: &mut S, entries: &[impl AsRef<str>]) {
    for (at, entry) in entries.iter().enumerate() {
        if at > 0 {
            out.push(", ");
        }
        out.bind(Bind::Text(entry.as_ref().to_string()));
    }
}

/// `held` compared with `value`.
pub fn compared<S: Sink>(
    out: &mut S,
    held: impl FnOnce(&mut S),
    compare: Compare,
    value: &Literal,
) {
    held(out);
    out.push(match compare {
        Compare::Eq => " = ",
        Compare::Neq => " != ",
        Compare::Gt => " > ",
        Compare::Gte => " >= ",
        Compare::Lt => " < ",
        Compare::Lte => " <= ",
        Compare::Contains | Compare::StartsWith => " LIKE ",
    });
    match compare {
        Compare::Contains => out.bind(Bind::Text(format!("%{}%", escape_like(&value.text())))),
        Compare::StartsWith => out.bind(Bind::Text(format!("{}%", escape_like(&value.text())))),
        _ => return out.bind(bound(value)),
    }
    out.push(" ESCAPE '\\'");
}

/// A condition on the value `held`, whose JSON type is `kind`.
pub fn held_property<S: Sink>(
    out: &mut S,
    held: impl Fn(&mut S),
    kind: impl Fn(&mut S),
    op: Op,
    value: &Literal,
) {
    match op {
        Op::Compare(compare @ (Compare::Eq | Compare::Neq))
            if matches!(value, Literal::Number(_)) =>
        {
            let number = |out: &mut S| {
                out.push("CASE WHEN ");
                kind(out);
                out.push(" IN ('integer', 'real') THEN CAST(");
                held(out);
                out.push(" AS REAL) ELSE ");
                held(out);
                out.push(" END");
            };
            compared(out, number, compare, value);
        }
        Op::Compare(compare @ (Compare::Gt | Compare::Gte | Compare::Lt | Compare::Lte))
            if matches!(value, Literal::Number(_)) =>
        {
            let number = |out: &mut S| {
                out.push("CAST(");
                held(out);
                out.push(" AS REAL)");
            };
            compared(out, number, compare, value);
        }
        Op::Compare(compare) => compared(out, held, compare, value),
        Op::Exists => {
            held(out);
            out.push(" IS NOT NULL");
        }
        Op::NotExists => {
            held(out);
            out.push(" IS NULL");
        }
    }
}

fn json_path<S: Sink>(out: &mut S, name: &str) {
    out.bind(Bind::Text(format!("$.{name}")));
}

/// A condition on member `name` of the item's `properties`.
fn property<S: Sink>(out: &mut S, items: &Items, name: &str, op: Op, value: &Literal) {
    let source = items.properties();
    items.guarded(out, |out| {
        let held = |out: &mut S| {
            out.push(&format!("json_extract({source}, "));
            json_path(out, name);
            out.push(")");
        };
        let kind = |out: &mut S| {
            out.push(&format!("json_type({source}, "));
            json_path(out, name);
            out.push(")");
        };
        held_property(out, held, kind, op, value);
    });
}

/// Some entry of the list `field` is an object whose `member` equals the value. `CASE` keeps
/// `json_extract` off an entry that is not an object.
fn entry<S: Sink>(out: &mut S, items: &Items, field: &str, member: &str, value: &Literal) {
    let source = items.properties();
    items.guarded(out, |out| {
        out.push(&format!("EXISTS (SELECT 1 FROM json_each({source}, "));
        json_path(out, field);
        out.push(&format!(") AS entry WHERE json_type({source}, "));
        json_path(out, field);
        out.push(") = 'array' AND ");
        if matches!(value, Literal::Number(_)) {
            out.push("CASE WHEN entry.type <> 'object' THEN NULL WHEN json_type(entry.value, ");
            json_path(out, member);
            out.push(") IN ('integer', 'real') THEN CAST(json_extract(entry.value, ");
            json_path(out, member);
            out.push(") AS REAL) ELSE json_extract(entry.value, ");
            json_path(out, member);
            out.push(") END");
        } else {
            out.push("CASE WHEN entry.type = 'object' THEN json_extract(entry.value, ");
            json_path(out, member);
            out.push(") END");
        }
        out.push(" = ");
        out.bind(bound(value));
        out.push(")");
    });
}

/// A row whose type has no status field, or whose value is no word its type declares, is in no
/// group, so `eq` and `neq` both pass it by and `not_exists` takes it. Each type's status field
/// gives the row's words, and the words give its group.
fn status_group<S: Sink>(
    out: &mut S,
    items: &Items,
    op: Op,
    value: &Literal,
    statuses: &[StatusField],
) {
    let wanted = |group: &str| match (op, value) {
        (Op::Compare(Compare::Eq), Literal::Text(asked)) => group == asked,
        (Op::Compare(Compare::Neq), Literal::Text(asked)) => group != asked,
        _ => true,
    };
    // Types that share a field and the words it selects are compared together.
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
        out.push("NOT ");
    }
    if selections.is_empty() {
        return out.push("0");
    }
    let source = items.properties();
    // `IFNULL`, since an absent value compares as unknown, and `NOT` an unknown would pass the
    // row by rather than take it.
    out.push("IFNULL((");
    for (at, (name, words, types)) in selections.iter().enumerate() {
        if at > 0 {
            out.push(" OR ");
        }
        out.push(&format!("({}.type IN (", items.alias));
        list(out, types);
        out.push(") AND ");
        items.guarded(out, |out| {
            out.push(&format!("json_extract({source}, "));
            out.bind(Bind::Text(format!(
                "$.{}",
                Value::String((*name).to_string())
            )));
            out.push(") IN (");
            list(out, words);
            out.push(")");
        });
        out.push(")");
    }
    out.push("), 0)");
}

/// The conditions of `expression`, joined as it joins them. A term of the item's own columns,
/// properties, entries or status groups is written here; one that reads a relation goes to
/// `relation`, which writes it in the caller's tables.
pub fn item_filter<S: Sink>(
    out: &mut S,
    expression: &Expression,
    items: &Items,
    catalog: &Catalog,
    mut relation: impl FnMut(&mut S, Relation) -> Result<()>,
) -> Result<()> {
    let statuses = if expression.reads_status() {
        catalog.status_fields()
    } else {
        Vec::new()
    };
    join(out, expression, |out, condition| {
        let value = &condition.value;
        match &condition.term {
            Term::System { column, compare } => {
                let literal = system_literal(column, *compare, value)?;
                let held = format!("{}.{column}", items.alias);
                compared(out, |out| out.push(&held), *compare, &literal);
            }
            Term::Property { name, op } => property(out, items, name, *op, value),
            Term::Entry { field, member } => entry(out, items, field, member, value),
            Term::StatusGroup(op) => status_group(out, items, *op, value, &statuses),
            Term::TagHeld => relation(out, Relation::Tag(value))?,
            Term::TagsPresent(present) => relation(out, Relation::Tags { present: *present })?,
            Term::Edge {
                edge_type,
                backref,
                negated,
                to_item,
            } => relation(
                out,
                Relation::Edge {
                    edge_type,
                    backref: *backref,
                    negated: *negated,
                    to: to_item.then_some(value),
                },
            )?,
            Term::Part(compare) => relation(
                out,
                Relation::Part {
                    selected: matches!(value, Literal::Bool(true)) == (*compare == Compare::Eq),
                },
            )?,
        }
        Ok(())
    })
}

fn join<S: Sink>(
    out: &mut S,
    expression: &Expression,
    mut each: impl FnMut(&mut S, &Condition) -> Result<()>,
) -> Result<()> {
    let joiner = if expression.any { " OR " } else { " AND " };
    out.push("(");
    for (at, condition) in expression.conditions.iter().enumerate() {
        if at > 0 {
            out.push(joiner);
        }
        each(out, condition)?;
    }
    out.push(")");
    Ok(())
}

/// A row filter of [`parse_rows`], over the columns `id` and `updated_at` of the alias `r` and the
/// table's own columns, which `held` and `kind` read: the value of a column, and its JSON type.
pub fn row_filter<S: Sink>(
    out: &mut S,
    expression: &Expression,
    held: impl Fn(&mut S, &str),
    kind: impl Fn(&mut S, &str),
) -> Result<()> {
    join(out, expression, |out, condition| {
        out.push("(");
        match &condition.term {
            Term::Property { name, op } => held_property(
                out,
                |out| held(out, name),
                |out| kind(out, name),
                *op,
                &condition.value,
            ),
            Term::System { column, compare } => {
                let literal = system_literal(column, *compare, &condition.value)?;
                let held = format!("r.{column}");
                compared(out, |out| out.push(&held), *compare, &literal);
            }
            _ => {
                return Err(RuleError::validation(
                    "A row filter names columns, id and updated_at.",
                ));
            }
        }
        out.push(")");
        Ok(())
    })
}

/// A row filter that names only columns `has_column` says the table declares.
pub fn table_filter(filter: &str, has_column: impl Fn(&str) -> bool) -> Result<Expression> {
    let expression = parse_rows(filter)?;
    for condition in &expression.conditions {
        if let Term::Property { name, .. } = &condition.term
            && !has_column(name)
        {
            return Err(RuleError::validation(format!(
                "The table declares no column \"{name}\"."
            )));
        }
    }
    Ok(expression)
}

/// A column a table adds up, by the way it adds.
#[derive(Clone, Debug, PartialEq)]
pub struct Adding {
    pub name: String,
    pub kind: String,
    pub way: String,
}

/// The columns of `columns` that add up and that a client can name.
pub fn adding(columns: &Map<String, Value>) -> Vec<Adding> {
    columns
        .iter()
        .filter_map(|(name, definition)| {
            let way = definition.get("adds_up")?.as_str()?;
            let kind = definition.get("type")?.as_str()?;
            api_name(name).then(|| Adding {
                name: name.clone(),
                kind: kind.to_string(),
                way: way.to_string(),
            })
        })
        .collect()
}

/// One total over a column: `held` is its value and `number` the value only where it is a number.
/// Datetimes compare by instant and return UTC.
pub fn total<S: Sink>(
    out: &mut S,
    adding: &Adding,
    held: impl Fn(&mut S),
    number: impl Fn(&mut S),
) {
    let wrapped = |out: &mut S, open: &str, inner: &dyn Fn(&mut S), close: &str| {
        out.push(open);
        inner(out);
        out.push(close);
    };
    match (adding.way.as_str(), adding.kind.as_str()) {
        ("count", _) => wrapped(out, "COUNT(", &held, ")"),
        ("sum", _) => wrapped(out, "TOTAL(", &number, ")"),
        ("average", _) => wrapped(out, "AVG(", &number, ")"),
        ("min", "date") => wrapped(out, "MIN(", &held, ")"),
        ("max", "date") => wrapped(out, "MAX(", &held, ")"),
        ("min", "datetime") => wrapped(
            out,
            "strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday(",
            &held,
            ")))",
        ),
        ("max", "datetime") => wrapped(
            out,
            "strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(",
            &held,
            ")))",
        ),
        ("min", _) => wrapped(out, "MIN(", &number, ")"),
        _ => wrapped(out, "MAX(", &number, ")"),
    }
}

/// The whole number a total reads as, when it is one a client holds exactly: the count and the
/// totals of an integer column are whole.
pub fn whole_total(kind: &str, way: &str, value: f64) -> Option<i64> {
    let integer = kind == "integer" || way == "count";
    (integer && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0)
        .then_some(value as i64)
}
