//! The server's listing grammar, answered from the working copy. A port, not
//! a lookalike: the parser refuses what the server's refuses, with its code,
//! and each condition compiles to the SQL the server runs, bound as its
//! driver binds it. Read even slightly otherwise, a condition answers one set
//! of rows offline and another online.

use serde_json::{Number, Value};

use crate::Result;
use crate::catalog::{Catalog, STATUS_GROUPS, StatusField};
use crate::error::CoreError;
use crate::js;
use crate::query::escape_like;

mod model;

pub use model::{
    EdgeDirection, FilterCondition, FilterExpression, FilterField, FilterJoin, FilterOperator,
    FilterValue, SystemField,
};

/// Measured in UTF-16 code units, which is what the server's `length` counts.
const MAX_INPUT_LENGTH: usize = 2048;
const MAX_CONDITIONS: usize = 10;

const SYSTEM_FIELDS: [&str; 10] = [
    "state",
    "type",
    "source",
    "occurred_at",
    "created_at",
    "updated_at",
    "tier",
    "version",
    "id",
    "source_id",
];

/// The term that selects by the group of each item's status word.
const STATUS_GROUP: &str = "status_group";

/// The edge type `beneath` walks: an edge's source is the parent and its
/// target the child.
pub(crate) const PARENT_OF: &str = "parent-of";

/// An expression the copy cannot answer as the server would is refused,
/// never dropped, but for an edge type the key may not read, which the copy
/// cannot know. `whole` is the edge types the copy holds whole
/// (`store::whole_edge_types`): a `backref` term is answered only on one of
/// them, since a copy holds the other edge types only as its own items draw
/// them. A `status_group` term reads each type's status field from `catalog`.
pub(crate) fn narrow(
    filter: Option<&str>,
    beneath: Option<&str>,
    whole: &[String],
    catalog: &Catalog,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    if let Some(filter) = filter {
        let expression = parse(filter)?;
        let statuses = if expression.reads_status() {
            catalog.status_fields()
        } else {
            Vec::new()
        };
        clauses.push(expression.clause(values, whole, &statuses)?);
    }
    if let Some(root) = beneath {
        // `UNION`, not `UNION ALL`: a copy can hold a cycle the server would
        // refuse, from edges queued locally, and only a set ends the walk.
        clauses.push(format!(
            "items.id IN (WITH RECURSIVE beneath(id) AS (
               SELECT ?
               UNION
               SELECT edges.target_id FROM edges JOIN beneath ON edges.source_id = beneath.id
               WHERE edges.edge_type = '{PARENT_OF}'
             ) SELECT id FROM beneath)"
        ));
        values.push(Value::String(root.to_string()));
    }
    Ok(())
}

/// Refuses, before any read, what `narrow` would refuse for this expression
/// on a copy that holds no edge type whole.
pub(crate) fn check(filter: &str) -> Result<()> {
    parse(filter)?.clause(&mut Vec::new(), &[], &[]).map(|_| ())
}

#[derive(Debug, Clone, PartialEq)]
enum Literal {
    Text(String),
    Number(f64),
    Bool(bool),
    /// No value: the operator takes none. A `null` in the expression is
    /// refused, never read as this.
    Null,
}

impl Literal {
    /// As the server's driver binds it: every number, a boolean included,
    /// goes in as a REAL. It matters against a text column, whose affinity
    /// turns `5` into `'5.0'` rather than `'5'`.
    fn bound(&self) -> Value {
        match self {
            Literal::Text(text) => Value::String(text.clone()),
            Literal::Number(number) => real(*number),
            Literal::Bool(flag) => real(if *flag { 1.0 } else { 0.0 }),
            Literal::Null => Value::Null,
        }
    }

    /// The text a pattern operator matches, as JavaScript's `String()` gives
    /// it.
    fn text(&self) -> String {
        match self {
            Literal::Text(text) => text.clone(),
            Literal::Number(number) => js::number(*number),
            Literal::Bool(flag) => flag.to_string(),
            Literal::Null => "null".into(),
        }
    }
}

fn real(number: f64) -> Value {
    Number::from_f64(number).map_or(Value::Null, Value::Number)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Compare {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    StartsWith,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    Compare(Compare),
    Exists,
    NotExists,
}

impl Op {
    fn parse(name: &str) -> Option<Op> {
        Some(match name {
            "eq" => Op::Compare(Compare::Eq),
            "neq" => Op::Compare(Compare::Neq),
            "gt" => Op::Compare(Compare::Gt),
            "gte" => Op::Compare(Compare::Gte),
            "lt" => Op::Compare(Compare::Lt),
            "lte" => Op::Compare(Compare::Lte),
            "contains" => Op::Compare(Compare::Contains),
            "starts_with" => Op::Compare(Compare::StartsWith),
            "exists" => Op::Exists,
            "not_exists" => Op::NotExists,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Op::Compare(Compare::Eq) => "eq",
            Op::Compare(Compare::Neq) => "neq",
            Op::Compare(Compare::Gt) => "gt",
            Op::Compare(Compare::Gte) => "gte",
            Op::Compare(Compare::Lt) => "lt",
            Op::Compare(Compare::Lte) => "lte",
            Op::Compare(Compare::Contains) => "contains",
            Op::Compare(Compare::StartsWith) => "starts_with",
            Op::Exists => "exists",
            Op::NotExists => "not_exists",
        }
    }
}

/// What a condition asks, with the operators each field refuses already
/// refused.
#[derive(Debug, Clone, PartialEq)]
enum Term {
    System {
        column: &'static str,
        compare: Compare,
    },
    Property {
        name: String,
        op: Op,
    },
    /// `properties.<field>.<member> eq <value>`, the only operator it takes.
    Entry {
        field: String,
        member: String,
    },
    TagHeld,
    TagsPresent(bool),
    Edge {
        edge_type: String,
        backref: bool,
        negated: bool,
        to_item: bool,
    },
    /// The value, where the operator takes one, is one of `STATUS_GROUPS`.
    StatusGroup(Op),
}

#[derive(Debug, Clone, PartialEq)]
struct Condition {
    term: Term,
    /// `Null` where the operator takes no value.
    value: Literal,
}

#[derive(Debug, Clone, PartialEq)]
struct Expression {
    conditions: Vec<Condition>,
    any: bool,
}

impl Expression {
    fn reads_status(&self) -> bool {
        self.conditions
            .iter()
            .any(|condition| matches!(condition.term, Term::StatusGroup(_)))
    }

    fn clause(
        &self,
        values: &mut Vec<Value>,
        whole: &[String],
        statuses: &[StatusField],
    ) -> Result<String> {
        let joiner = if self.any { " OR " } else { " AND " };
        let parts = self
            .conditions
            .iter()
            .map(|condition| condition.clause(values, whole, statuses))
            .collect::<Result<Vec<String>>>()?;
        Ok(format!("({})", parts.join(joiner)))
    }
}

impl Condition {
    fn clause(
        &self,
        values: &mut Vec<Value>,
        whole: &[String],
        statuses: &[StatusField],
    ) -> Result<String> {
        Ok(match &self.term {
            Term::System { column, compare } => compared(
                &format!("items.{column}"),
                *compare,
                &system_literal(column, *compare, &self.value)?,
                values,
            ),
            Term::Property { name, op } => {
                values.push(Value::String(format!("$.{name}")));
                let extract = "json_extract(items.properties, ?)";
                // SQLite raises on stored text that is not JSON and so would
                // fail the whole query for one damaged row; such a row matches
                // no property condition. `CASE`, not `AND`, because SQLite
                // promises no order of evaluation for `AND`.
                let clause = match op {
                    Op::Compare(compare @ (Compare::Eq | Compare::Neq))
                        if matches!(self.value, Literal::Number(_)) =>
                    {
                        values.extend(std::iter::repeat_n(Value::String(format!("$.{name}")), 2));
                        compared(
                            &format!(
                                "CASE WHEN json_type(items.properties, ?) IN ('integer', 'real') THEN CAST({extract} AS REAL) ELSE {extract} END"
                            ),
                            *compare,
                            &self.value,
                            values,
                        )
                    }
                    Op::Compare(
                        compare @ (Compare::Gt | Compare::Gte | Compare::Lt | Compare::Lte),
                    ) if matches!(self.value, Literal::Number(_)) => compared(
                        &format!("CAST({extract} AS REAL)"),
                        *compare,
                        &self.value,
                        values,
                    ),
                    Op::Compare(compare) => compared(extract, *compare, &self.value, values),
                    Op::Exists => format!("{extract} IS NOT NULL"),
                    Op::NotExists => format!("{extract} IS NULL"),
                };
                format!("CASE WHEN json_valid(items.properties) THEN ({clause}) ELSE 0 END")
            }
            // The server's `entryMemberSql`: some entry of the list is an
            // object whose member equals the value. `CASE` keeps
            // `json_extract` off an entry that is not an object.
            Term::Entry { field, member } => {
                let list = format!("$.{field}");
                let path = format!("$.{member}");
                let extract = "json_extract(entry.value, ?)";
                let member_value = if matches!(self.value, Literal::Number(_)) {
                    values.extend([
                        Value::String(list.clone()),
                        Value::String(list),
                        Value::String(path.clone()),
                        Value::String(path.clone()),
                        Value::String(path),
                    ]);
                    format!(
                        "CASE WHEN entry.type <> 'object' THEN NULL WHEN json_type(entry.value, ?) IN ('integer', 'real') THEN CAST({extract} AS REAL) ELSE {extract} END"
                    )
                } else {
                    values.extend([
                        Value::String(list.clone()),
                        Value::String(list),
                        Value::String(path),
                    ]);
                    format!("CASE WHEN entry.type = 'object' THEN {extract} END")
                };
                values.push(self.value.bound());
                format!(
                    "CASE WHEN json_valid(items.properties) THEN EXISTS (SELECT 1 FROM json_each(items.properties, ?) AS entry WHERE json_type(items.properties, ?) = 'array' AND {member_value} = ?) ELSE 0 END"
                )
            }
            // `+` takes the column's text affinity off, so a number is
            // compared as the number it is, as it is against the server's
            // JSON array, and never matches a tag spelled like it.
            Term::TagHeld => {
                values.push(self.value.bound());
                "EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id AND +tags.tag = ?)".into()
            }
            Term::TagsPresent(present) => format!(
                "{}EXISTS (SELECT 1 FROM tags WHERE tags.item_id = items.id)",
                if *present { "" } else { "NOT " }
            ),
            Term::Edge {
                edge_type,
                backref,
                negated,
                to_item,
            } => {
                // The copy holds the edges its items draw, not every edge
                // drawn to them, unless it holds the type whole.
                if *backref && !whole.contains(edge_type) {
                    return Err(CoreError::Invalid(format!(
                        "a backref condition on {edge_type:?} is not answered from a working copy that does not hold that edge type whole: hydrate with it as an edge type held whole, or ask the server"
                    )));
                }
                let (own, far) = if *backref {
                    ("target_id", "source_id")
                } else {
                    ("source_id", "target_id")
                };
                values.push(Value::String(edge_type.clone()));
                let other = if *to_item {
                    values.push(self.value.bound());
                    format!(" AND e.{far} = ?")
                } else {
                    String::new()
                };
                format!(
                    "{}EXISTS (SELECT 1 FROM edges e WHERE e.{own} = items.id AND e.edge_type = ?{other})",
                    if *negated { "NOT " } else { "" }
                )
            }
            Term::StatusGroup(op) => status_group(*op, &self.value, statuses, values),
        })
    }
}

/// The literal a system field is compared with: a time column compared as
/// an instant takes a timestamp, which is normalized, and refuses anything
/// else as the server's SQL builder refuses it.
fn system_literal(column: &str, compare: Compare, value: &Literal) -> Result<Literal> {
    if !matches!(column, "created_at" | "updated_at" | "occurred_at")
        || matches!(compare, Compare::Contains | Compare::StartsWith)
    {
        return Ok(value.clone());
    }
    let Literal::Text(text) = value else {
        return Err(crate::time::invalid(column, "expected a timestamp"));
    };
    Ok(Literal::Text(crate::time::normalize(text, column)?))
}

/// A `status_group` term, answered through each type's status field: the
/// row's type picks the field and its words, and the words pick the group. A
/// row whose type has no status field, or whose value is no word its type
/// declares, is in no group, so `eq` and `neq` both pass it by and
/// `not_exists` takes it.
fn status_group(
    op: Op,
    value: &Literal,
    statuses: &[StatusField],
    values: &mut Vec<Value>,
) -> String {
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
    let placeholders = |count: usize| vec!["?"; count].join(", ");
    let mut parts = Vec::new();
    for (name, words, types) in selections {
        let path = format!("$.{}", Value::String(name.to_string()));
        parts.push(format!(
            "(items.type IN ({}) AND CASE WHEN json_valid(items.properties) THEN json_extract(items.properties, ?) IN ({}) ELSE 0 END)",
            placeholders(types.len()),
            placeholders(words.len()),
        ));
        values.extend(types.into_iter().map(|id| Value::String(id.into())));
        values.push(Value::String(path));
        values.extend(words.into_iter().map(|word| Value::String(word.into())));
    }
    // `IFNULL`, since an absent value compares as unknown, and `NOT` an
    // unknown would pass the row by rather than take it.
    let matched = if parts.is_empty() {
        "0".to_string()
    } else {
        format!("IFNULL(({}), 0)", parts.join(" OR "))
    };
    if op == Op::NotExists {
        format!("NOT {matched}")
    } else {
        matched
    }
}

fn compared(
    expression: &str,
    compare: Compare,
    value: &Literal,
    values: &mut Vec<Value>,
) -> String {
    let (operator, bound) = match compare {
        Compare::Eq => ("=", value.bound()),
        Compare::Neq => ("!=", value.bound()),
        Compare::Gt => (">", value.bound()),
        Compare::Gte => (">=", value.bound()),
        Compare::Lt => ("<", value.bound()),
        Compare::Lte => ("<=", value.bound()),
        Compare::Contains => (
            "LIKE",
            Value::String(format!("%{}%", escape_like(&value.text()))),
        ),
        Compare::StartsWith => (
            "LIKE",
            Value::String(format!("{}%", escape_like(&value.text()))),
        ),
    };
    values.push(bound);
    if operator == "LIKE" {
        format!("{expression} LIKE ? ESCAPE '\\'")
    } else {
        format!("{expression} {operator} ?")
    }
}

fn refused(message: impl Into<String>) -> CoreError {
    CoreError::Validation {
        code: "validation_error".into(),
        message: message.into(),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Identifier(String),
    Text(String),
    Number(f64),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    raw: String,
    pos: usize,
}

/// `edge[<type>]` or `backref[<type>]`, whole: the type is anything but a
/// closing bracket or whitespace, and not nothing.
fn edge_ref(word: &str) -> Option<(bool, &str)> {
    let (backref, rest) = if let Some(rest) = word.strip_prefix("edge[") {
        (false, rest)
    } else {
        (true, word.strip_prefix("backref[")?)
    };
    let edge_type = rest.strip_suffix(']')?;
    if edge_type.is_empty() || edge_type.contains(']') || edge_type.chars().any(js::is_space) {
        return None;
    }
    Some((backref, edge_type))
}

fn tokenize(input: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = input.chars().collect();
    // Positions in UTF-16 code units, as the server's string index counts.
    let at: Vec<usize> = chars
        .iter()
        .scan(0, |units, ch| {
            let here = *units;
            *units += ch.len_utf16();
            Some(here)
        })
        .collect();
    let raw = |from: usize, to: usize| chars[from..to].iter().collect::<String>();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' {
            i += 1;
            continue;
        }
        if ch == '"' {
            let start = i;
            i += 1;
            let mut value = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && chars.get(i + 1) == Some(&'"') {
                    value.push('"');
                    i += 2;
                } else {
                    value.push(chars[i]);
                    i += 1;
                }
            }
            if i >= chars.len() {
                return Err(refused(format!(
                    "Unterminated string starting at position {}",
                    at[start]
                )));
            }
            i += 1;
            tokens.push(Token {
                kind: TokenKind::Text(value),
                raw: raw(start, i),
                pos: at[start],
            });
            continue;
        }
        let digit_at = |at: usize| chars.get(at).is_some_and(char::is_ascii_digit);
        if ch.is_ascii_digit() || (ch == '-' && digit_at(i + 1)) {
            let start = i;
            if ch == '-' {
                i += 1;
            }
            while digit_at(i) {
                i += 1;
            }
            if chars.get(i) == Some(&'.') {
                i += 1;
                while digit_at(i) {
                    i += 1;
                }
            }
            let text = raw(start, i);
            // Enough digits read as infinity, which the server refuses.
            let number = text
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .ok_or_else(|| {
                    refused(format!(
                        "Number out of range \"{text}\" at position {}",
                        at[start]
                    ))
                })?;
            tokens.push(Token {
                kind: TokenKind::Number(number),
                raw: text,
                pos: at[start],
            });
            continue;
        }
        if ch == 'e' || ch == 'b' {
            let end = chars[i..]
                .iter()
                .position(|c| js::is_space(*c))
                .map_or(chars.len(), |offset| i + offset);
            let word = raw(i, end);
            if edge_ref(&word).is_some() {
                tokens.push(Token {
                    kind: TokenKind::Identifier(word.clone()),
                    raw: word,
                    pos: at[i],
                });
                i = end;
                continue;
            }
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            while chars
                .get(i)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
            {
                i += 1;
            }
            let word = raw(start, i);
            let kind = match word.as_str() {
                "true" => TokenKind::Bool(true),
                "false" => TokenKind::Bool(false),
                "null" => TokenKind::Null,
                _ => TokenKind::Identifier(word.clone()),
            };
            tokens.push(Token {
                kind,
                raw: word,
                pos: at[start],
            });
            continue;
        }
        return Err(refused(format!(
            "Unexpected character '{ch}' at position {}",
            at[i]
        )));
    }
    Ok(tokens)
}

enum Field {
    System(&'static str),
    Property(String),
    Entry { field: String, member: String },
    Tags,
    StatusGroup,
    Edge { edge_type: String, backref: bool },
}

fn field(token: &Token) -> Result<Field> {
    let TokenKind::Identifier(name) = &token.kind else {
        return Err(refused(format!(
            "Expected field name at position {}, got {}",
            token.pos, token.raw
        )));
    };
    if let Some((backref, edge_type)) = edge_ref(name) {
        return Ok(Field::Edge {
            edge_type: edge_type.to_string(),
            backref,
        });
    }
    if name == "tags" {
        return Ok(Field::Tags);
    }
    if name == STATUS_GROUP {
        return Ok(Field::StatusGroup);
    }
    if let Some(path) = name.strip_prefix("properties.") {
        if path.is_empty() {
            return Err(refused(format!(
                "Missing property name after \"properties.\" at position {}",
                token.pos
            )));
        }
        let names: Vec<&str> = path.split('.').collect();
        if names.len() > 2 {
            return Err(refused(format!(
                "Nested property paths are not supported. Use \"properties.<field>\", or \"properties.<field>.<member>\" for a member of a list's entries, at position {}",
                token.pos
            )));
        }
        for name in &names {
            let mut chars = name.chars();
            let valid = chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !valid {
                return Err(refused(format!(
                    "Invalid property name \"{name}\". Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/"
                )));
            }
        }
        return Ok(match names.as_slice() {
            [field, member] => Field::Entry {
                field: (*field).to_string(),
                member: (*member).to_string(),
            },
            _ => Field::Property(path.to_string()),
        });
    }
    if let Some(column) = SYSTEM_FIELDS.iter().find(|column| **column == name) {
        return Ok(Field::System(column));
    }
    Err(refused(format!(
        "Unknown field \"{name}\" at position {}. Valid system fields: {}. Use \"properties.<field>\" for custom fields, \"tags\" for tag filtering, or \"status_group\" for a status group.",
        token.pos,
        SYSTEM_FIELDS.join(", ")
    )))
}

fn op(token: &Token) -> Result<Op> {
    let TokenKind::Identifier(name) = &token.kind else {
        return Err(refused(format!(
            "Expected operator at position {}, got {}",
            token.pos, token.raw
        )));
    };
    Op::parse(name).ok_or_else(|| {
        refused(format!(
            "Unknown operator \"{name}\" at position {}. Valid operators: eq, neq, gt, gte, lt, lte, contains, starts_with, exists, not_exists",
            token.pos
        ))
    })
}

fn term(field: Field, op: Op) -> Result<Term> {
    Ok(match field {
        Field::Tags => match op {
            Op::Compare(Compare::Contains) => Term::TagHeld,
            Op::Exists => Term::TagsPresent(true),
            Op::NotExists => Term::TagsPresent(false),
            Op::Compare(_) => {
                return Err(refused(format!(
                    "Operator \"{}\" is not valid for \"tags\". Use: contains, exists, not_exists",
                    op.name()
                )));
            }
        },
        Field::StatusGroup => match op {
            Op::Compare(Compare::Eq | Compare::Neq) | Op::Exists | Op::NotExists => {
                Term::StatusGroup(op)
            }
            Op::Compare(_) => {
                return Err(refused(format!(
                    "Operator \"{}\" is not valid for \"{STATUS_GROUP}\". Use: eq, neq, exists, not_exists",
                    op.name()
                )));
            }
        },
        Field::Edge { edge_type, backref } => {
            let (negated, to_item) = match op {
                Op::Compare(Compare::Eq) => (false, true),
                Op::Compare(Compare::Neq) => (true, true),
                Op::Exists => (false, false),
                Op::NotExists => (true, false),
                Op::Compare(_) => {
                    return Err(refused(format!(
                        "Operator \"{}\" is not valid for edge references. Use: eq, neq, exists, not_exists",
                        op.name()
                    )));
                }
            };
            Term::Edge {
                edge_type,
                backref,
                negated,
                to_item,
            }
        }
        Field::System(column) => match op {
            Op::Compare(compare) => Term::System { column, compare },
            Op::Exists | Op::NotExists => {
                return Err(refused(format!(
                    "Operator \"{}\" is not valid for system field \"{column}\". System fields always exist.",
                    op.name()
                )));
            }
        },
        Field::Property(name) => Term::Property { name, op },
        Field::Entry { field, member } => match op {
            Op::Compare(Compare::Eq) => Term::Entry { field, member },
            _ => {
                return Err(refused(format!(
                    "Operator \"{}\" is not valid for a member of a list's entries. Use: eq",
                    op.name()
                )));
            }
        },
    })
}

/// A comparison with null is unknown in SQL and never matches, so the server
/// refuses the literal and names the operator that asks the question.
fn refuse_null(token: &Token, term: &Term, op: Op) -> CoreError {
    let never = format!(
        "Null is not a value to compare with, so \"{} null\" never matches at position {}.",
        op.name(),
        token.pos
    );
    refused(match term {
        Term::Property { .. } => format!(
            "{never} Use \"not_exists\" to ask for a property that is absent or null, and \"exists\" for one that has a value"
        ),
        Term::Edge { .. } => format!(
            "{never} Use \"not_exists\" to ask for rows that draw no edge of this type, and \"exists\" for rows that draw one"
        ),
        Term::System { column, .. } => format!("{never} Compare \"{column}\" with a value"),
        Term::Entry { field, member } => {
            format!("{never} Compare \"properties.{field}.{member}\" with a value")
        }
        Term::TagHeld | Term::TagsPresent(_) => format!("{never} Name the tag to look for"),
        Term::StatusGroup(_) => format!(
            "{never} Use \"not_exists\" to ask for items with no status word their type declares, and \"exists\" for items with one"
        ),
    })
}

fn value(token: &Token, term: &Term, op: Op) -> Result<Literal> {
    Ok(match &token.kind {
        TokenKind::Text(text) => Literal::Text(text.clone()),
        TokenKind::Number(number) => Literal::Number(*number),
        TokenKind::Bool(flag) => Literal::Bool(*flag),
        TokenKind::Null => return Err(refuse_null(token, term, op)),
        TokenKind::Identifier(_) => {
            return Err(refused(format!(
                "Expected value at position {}, got \"{}\"",
                token.pos, token.raw
            )));
        }
    })
}

fn expect<'a>(tokens: &'a [Token], pos: usize, context: &str) -> Result<&'a Token> {
    tokens.get(pos).ok_or_else(|| {
        let after = pos
            .checked_sub(1)
            .and_then(|previous| tokens.get(previous))
            .map(|previous| format!(" after \"{}\"", previous.raw))
            .unwrap_or_default();
        refused(format!(
            "Unexpected end of expression{after}: expected {context}"
        ))
    })
}

fn parse(input: &str) -> Result<Expression> {
    // JavaScript's `trim`, which takes U+FEFF and leaves U+0085.
    if input.chars().all(js::is_space) {
        return Err(refused("Filter expression cannot be empty"));
    }
    let length = input.encode_utf16().count();
    if length > MAX_INPUT_LENGTH {
        return Err(refused(format!(
            "Filter expression too long ({length} characters). Maximum is {MAX_INPUT_LENGTH}"
        )));
    }
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err(refused("Filter expression cannot be empty"));
    }
    let mut conditions = Vec::new();
    let mut logical: Option<bool> = None;
    let mut pos = 0;
    while pos < tokens.len() {
        let field = field(expect(&tokens, pos, "field name")?)?;
        pos += 1;
        let op = op(expect(&tokens, pos, "operator")?)?;
        pos += 1;
        let term = term(field, op)?;
        let value = if matches!(op, Op::Compare(_)) {
            let token = expect(&tokens, pos, "value")?;
            let literal = value(token, &term, op)?;
            if matches!(term, Term::StatusGroup(_))
                && !matches!(&literal, Literal::Text(group) if STATUS_GROUPS.contains(&group.as_str()))
            {
                return Err(refused(format!(
                    "Unknown status group {} at position {}. Status groups: {}",
                    token.raw,
                    token.pos,
                    STATUS_GROUPS.join(", ")
                )));
            }
            pos += 1;
            literal
        } else {
            Literal::Null
        };
        conditions.push(Condition { term, value });
        if conditions.len() > MAX_CONDITIONS {
            return Err(refused(format!(
                "Too many conditions ({}). Maximum is {MAX_CONDITIONS}",
                conditions.len()
            )));
        }
        if let Some(token) = tokens.get(pos) {
            let any = match &token.kind {
                TokenKind::Identifier(word) if word == "AND" => false,
                TokenKind::Identifier(word) if word == "OR" => true,
                TokenKind::Identifier(word) => {
                    return Err(refused(format!(
                        "Expected AND or OR at position {}, got \"{word}\"",
                        token.pos
                    )));
                }
                _ => {
                    return Err(refused(format!(
                        "Expected AND or OR at position {}, got \"{}\"",
                        token.pos, token.raw
                    )));
                }
            };
            if logical.is_some_and(|earlier| earlier != any) {
                return Err(refused(format!(
                    "Cannot mix AND and OR in a single filter expression. Found \"{}\" at position {} after \"{}\" used earlier. Use only AND or only OR.",
                    token.raw,
                    token.pos,
                    if any { "AND" } else { "OR" }
                )));
            }
            logical = Some(any);
            pos += 1;
            if pos >= tokens.len() {
                return Err(refused(format!(
                    "Unexpected end of expression after \"{}\": expected another condition",
                    token.raw
                )));
            }
        }
    }
    Ok(Expression {
        conditions,
        any: logical.unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::catalog::Indexing;
    use crate::store;
    use crate::store::testing::*;

    fn code(input: &str) -> Option<String> {
        match parse(input) {
            Ok(_) => None,
            Err(CoreError::Validation { code, .. }) => Some(code),
            Err(other) => Some(format!("{other:?}")),
        }
    }

    #[test]
    fn timestamp_comparisons_normalize_and_validate() {
        for field in ["created_at", "updated_at", "occurred_at"] {
            for op in ["eq", "neq", "gt", "gte", "lt", "lte"] {
                let mut values = Vec::new();
                parse(&format!("{field} {op} \"2026-01-01T01:00:00.500+01:00\""))
                    .unwrap()
                    .clause(&mut values, &[], &[])
                    .unwrap();
                assert_eq!(values, [Value::String("2026-01-01T00:00:00.500Z".into())]);
                for invalid in ["42", "true", "null", "\"bad\""] {
                    assert!(
                        matches!(check(&format!("{field} {op} {invalid}")), Err(CoreError::Validation { code, .. }) if code == "validation_error")
                    );
                }
            }
        }
    }

    #[test]
    fn refuses_what_the_server_refuses_with_its_code() {
        let refusal = Some("validation_error".to_string());
        for input in [
            "",
            "  \t ",
            "properties.a.b.c eq 1",
            "properties.a.b neq 1",
            "properties.a.b exists",
            "properties.a.1b eq 1",
            "properties. eq 1",
            "properties.1a eq 1",
            "properties eq 1",
            "title eq \"x\"",
            "tags eq \"x\"",
            "edge[parent-of] gt \"x\"",
            "id exists",
            "state eq active",
            "state eq \"a",
            "state eq \"a\" AND",
            "state eq \"a\" AND type eq \"b\" OR id eq \"c\"",
            "state eq \"a\" and type eq \"b\"",
            "state eq \"a\" type eq \"b\"",
            "state like \"a\"",
            "state eq",
            "edge[] exists",
            "edge[x]exists",
            "state eq \"a\"\n",
            "-x eq 1",
        ] {
            assert_eq!(code(input), refusal, "{input:?} was not refused");
        }
    }

    #[test]
    fn refuses_a_null_literal_and_names_the_test_that_asks_for_absence() {
        for op in [
            "eq",
            "neq",
            "gt",
            "gte",
            "lt",
            "lte",
            "contains",
            "starts_with",
        ] {
            let input = format!("properties.note {op} null");
            let Err(CoreError::Validation { code, message }) = parse(&input) else {
                panic!("{input} was accepted");
            };
            assert_eq!(code, "validation_error");
            assert!(message.contains(&format!("\"{op} null\" never matches")));
            assert!(message.contains("\"not_exists\""), "{message}");
        }
        for (input, advice) in [
            ("edge[about] eq null", "rows that draw no edge"),
            ("source_id eq null", "Compare \"source_id\" with a value"),
            ("tags contains null", "Name the tag to look for"),
            ("state eq \"a\" OR properties.n neq null", "never matches"),
        ] {
            let Err(CoreError::Validation { message, .. }) = parse(input) else {
                panic!("{input} was accepted");
            };
            assert!(message.contains(advice), "{input}: {message}");
        }
        // The word is text when it is quoted, and the presence test is
        // still how absence is asked for.
        assert_eq!(
            parse("properties.note eq \"null\"").unwrap().conditions[0].value,
            Literal::Text("null".into())
        );
        assert!(parse("properties.note not_exists").is_ok());
    }

    #[test]
    fn reads_values_and_edge_references_as_the_server_does() {
        let parsed =
            parse(r#"edge[core.parent-of] eq "a \"b\"" OR properties.n lte -2.5"#).unwrap();
        assert!(parsed.any);
        assert_eq!(
            parsed.conditions[0],
            Condition {
                term: Term::Edge {
                    edge_type: "core.parent-of".into(),
                    backref: false,
                    negated: false,
                    to_item: true,
                },
                value: Literal::Text("a \"b\"".into()),
            }
        );
        assert_eq!(parsed.conditions[1].value, Literal::Number(-2.5));
        let parsed = parse("backref[x] not_exists AND properties.f eq true").unwrap();
        assert!(!parsed.any);
        assert_eq!(parsed.conditions[1].value, Literal::Bool(true));
    }

    #[test]
    fn counts_the_length_in_utf16_units() {
        let emoji = |count: usize| format!("id eq \"{}\"", "\u{1F426}".repeat(count));
        assert_eq!(emoji(1020).encode_utf16().count(), 2048);
        assert!(parse(&emoji(1020)).is_ok());
        assert_eq!(emoji(1021).chars().count(), 1029);
        assert!(code(&emoji(1021)).is_some());
    }

    #[test]
    fn ends_an_edge_reference_where_javascript_space_ends_it() {
        let parsed = parse("edge[a\u{85}b] exists").unwrap();
        assert!(matches!(
            &parsed.conditions[0].term,
            Term::Edge { edge_type, .. } if edge_type == "a\u{85}b"
        ));
        assert!(code("edge[a\u{feff}b] exists").is_some());
    }

    fn message(input: &str) -> String {
        match parse(input) {
            Err(CoreError::Validation { message, .. }) => message,
            other => panic!("{input:?} was not refused: {other:?}"),
        }
    }

    #[test]
    fn names_a_position_in_utf16_units() {
        assert_eq!(
            message("id eq \"\u{1F426}\" OR x eq 1"),
            "Unknown field \"x\" at position 14. Valid system fields: state, type, source, occurred_at, created_at, updated_at, tier, version, id, source_id. Use \"properties.<field>\" for custom fields, \"tags\" for tag filtering, or \"status_group\" for a status group."
        );
        assert_eq!(
            message("id eq \"\u{1F426}\" \u{e9}"),
            "Unexpected character '\u{e9}' at position 11"
        );
    }

    #[test]
    fn refuses_a_number_no_double_holds() {
        let huge = format!("1{}", "0".repeat(400));
        assert_eq!(
            parse(&format!("properties.n gt {}", "9".repeat(308)))
                .unwrap()
                .conditions[0]
                .value,
            Literal::Number("9".repeat(308).parse().unwrap())
        );
        for input in [
            format!("properties.n gt {huge}"),
            format!("properties.n gt -{huge}"),
        ] {
            assert_eq!(code(&input).as_deref(), Some("validation_error"));
        }
    }

    fn family() -> Connection {
        let conn = conn();
        for (id, properties, tags) in [
            ("root", json!({ "rating": 5, "flag": true }), vec!["5.0"]),
            ("child", json!({ "rating": 2, "note": "A_b" }), vec![]),
            ("grandchild", json!({ "note": "Axb" }), vec![]),
            ("stranger", json!({ "rating": "9" }), vec![]),
        ] {
            let item = wire_item(
                id,
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            let tags: Vec<String> = tags.into_iter().map(str::to_string).collect();
            store::upsert_item(&conn, &item, Some(&tags), &Indexing::default()).unwrap();
        }
        for (id, source, target, edge_type) in [
            ("1", "root", "child", "parent-of"),
            ("2", "child", "grandchild", "parent-of"),
            ("3", "grandchild", "root", "parent-of"),
            ("4", "child", "stranger", "references"),
        ] {
            store::upsert_edge(&conn, &wire_edge(id, source, target, edge_type)).unwrap();
        }
        conn
    }

    /// Tasks with status words, a subtype that adds one, a type with no
    /// status field holding a property of the same name, and a stored word
    /// the type does not declare.
    fn statuses() -> Connection {
        let conn = conn();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(json!([
                { "id": "acme.task", "fields": { "state": { "type": "status", "status_values": [
                    { "value": "todo", "group": "not_started" },
                    { "value": "doing", "group": "in_progress" },
                    { "value": "done", "group": "completed" },
                    { "value": "dropped", "group": "canceled" }
                ] } } },
                { "id": "acme.chore", "parent": "acme.task", "fields": { "state": { "type": "status", "status_values": [
                    { "value": "waiting", "group": "in_progress" }
                ] } } },
                { "id": "acme.note", "fields": { "state": { "type": "string" } } }
            ]))
            .unwrap(),
            edge_types: Vec::new(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        for (id, r#type, properties) in [
            ("todo", "acme.task", json!({ "state": "todo" })),
            ("doing", "acme.task", json!({ "state": "doing" })),
            ("done", "acme.task", json!({ "state": "done" })),
            ("waiting", "acme.chore", json!({ "state": "waiting" })),
            ("chore-done", "acme.chore", json!({ "state": "done" })),
            ("task-waiting", "acme.task", json!({ "state": "waiting" })),
            ("pending", "acme.task", json!({ "state": "pending" })),
            ("blank", "acme.task", json!({})),
            ("note", "acme.note", json!({ "state": "done" })),
        ] {
            let item = wire_item(id, r#type, "active", "2026-01-01T00:00:00Z", properties);
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        conn
    }

    #[test]
    fn a_status_group_term_reads_each_types_own_words() {
        let conn = statuses();
        for (filter, matched) in [
            ("status_group eq \"in_progress\"", &["doing", "waiting"][..]),
            ("status_group eq \"completed\"", &["chore-done", "done"]),
            ("status_group eq \"canceled\"", &[]),
            (
                "status_group neq \"completed\"",
                &["doing", "todo", "waiting"],
            ),
            (
                "status_group exists",
                &["chore-done", "doing", "done", "todo", "waiting"],
            ),
            (
                "status_group not_exists",
                &["blank", "note", "pending", "task-waiting"],
            ),
            (
                "status_group eq \"not_started\" OR status_group eq \"completed\"",
                &["chore-done", "done", "todo"],
            ),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), matched, "{filter}");
        }
    }

    #[test]
    fn the_shipped_media_types_read_progress_as_their_status_field() {
        let conn = conn();
        store::replace_catalog(&conn, &crate::builtin::catalog().unwrap()).unwrap();
        for (subtype, word) in [
            ("album", "planned"),
            ("article", "started"),
            ("book", "finished"),
            ("episode", "abandoned"),
            ("film", "finished"),
            ("series", "planned"),
            ("song", "started"),
        ] {
            let item = wire_item(
                subtype,
                &format!("core.media.{subtype}"),
                "active",
                "2026-01-01T00:00:00Z",
                json!({ "title": "x", "progress": word }),
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        // A series' own `status` enum is not a status word, so it joins no group.
        let series = wire_item(
            "ongoing",
            "core.media.series",
            "active",
            "2026-01-01T00:00:00Z",
            json!({ "title": "x", "status": "ongoing" }),
        );
        store::upsert_item(&conn, &series, None, &Indexing::default()).unwrap();

        for (group, matched) in [
            ("not_started", &["album", "series"][..]),
            ("in_progress", &["article", "song"]),
            ("completed", &["book", "film"]),
            ("canceled", &["episode"]),
        ] {
            let filter = format!("status_group eq \"{group}\"");
            assert_eq!(ids(&conn, Some(&filter), None), matched, "{filter}");
        }
        assert_eq!(
            ids(&conn, Some("status_group not_exists"), None),
            ["ongoing"]
        );

        let catalog = Catalog::load(&conn).unwrap();
        let written = |word: &str| {
            let mut properties = serde_json::Map::new();
            properties.insert("title".into(), json!("x"));
            properties.insert("progress".into(), json!(word));
            catalog.validate_properties("core.media.book", &properties, true)
        };
        assert!(written("started").is_ok());
        assert!(written("reading").is_err());
    }

    #[test]
    fn a_status_group_term_takes_only_a_group_and_the_operators_that_ask_for_one() {
        for (input, said) in [
            ("status_group eq \"todo\"", "Unknown status group \"todo\""),
            ("status_group eq 1", "Unknown status group 1"),
            ("status_group neq true", "Unknown status group true"),
            (
                "status_group contains \"completed\"",
                "is not valid for \"status_group\"",
            ),
            (
                "status_group gt \"completed\"",
                "is not valid for \"status_group\"",
            ),
            (
                "status_group eq null",
                "\"not_exists\" to ask for items with no status word",
            ),
            (
                "status_groups exists",
                "or \"status_group\" for a status group",
            ),
        ] {
            let Err(CoreError::Validation { code, message }) = check(input) else {
                panic!("{input} was accepted");
            };
            assert_eq!(code, "validation_error");
            assert!(message.contains(said), "{input}: {message}");
        }
        // A copy that holds no status field answers every group with no row.
        let conn = family();
        assert!(ids(&conn, Some("status_group eq \"completed\""), None).is_empty());
        assert_eq!(ids(&conn, Some("status_group not_exists"), None).len(), 4);
    }

    #[test]
    fn a_member_term_matches_any_entry_and_no_field_that_is_not_a_list_of_objects() {
        let conn = conn();
        for (id, properties) in [
            (
                "second",
                json!({ "emails": [{ "value": "a@x.test" }, { "value": "b@x.test" }] }),
            ),
            (
                "first",
                json!({ "emails": [{ "value": "b@x.test", "label": "work" }] }),
            ),
            ("other", json!({ "emails": [{ "value": "c@x.test" }] })),
            ("text", json!({ "emails": "b@x.test" })),
            ("object", json!({ "emails": { "value": "b@x.test" } })),
            (
                "objects",
                json!({ "emails": { "x": { "value": "b@x.test" } } }),
            ),
            ("scalars", json!({ "emails": ["b@x.test", 1, null] })),
            ("member", json!({ "emails": [{ "address": "b@x.test" }] })),
            (
                "number",
                json!({ "ranks": [{ "value": 5.0 }, { "value": "5" }] }),
            ),
        ] {
            let item = wire_item(
                id,
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        conn.execute(
            "UPDATE items SET properties = '{\"emails\":' WHERE id = 'other'",
            [],
        )
        .unwrap();
        for (filter, matched) in [
            (
                "properties.emails.value eq \"b@x.test\"",
                &["first", "second"][..],
            ),
            ("properties.emails.label eq \"work\"", &["first"]),
            ("properties.ranks.value eq 5", &["number"]),
            ("properties.ranks.value eq \"5\"", &["number"]),
            ("properties.emails.value eq 1", &[]),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), matched, "{filter}");
        }
    }

    fn ids(conn: &Connection, filter: Option<&str>, beneath: Option<&str>) -> Vec<String> {
        ids_whole(conn, filter, beneath, &[])
    }

    fn ids_whole(
        conn: &Connection,
        filter: Option<&str>,
        beneath: Option<&str>,
        whole: &[&str],
    ) -> Vec<String> {
        let whole: Vec<String> = whole.iter().map(|held| held.to_string()).collect();
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        let catalog = Catalog::load(conn).unwrap();
        narrow(filter, beneath, &whole, &catalog, &mut clauses, &mut values).unwrap();
        let mut ids: Vec<String> = store::items_where(
            conn,
            &clauses.join(" AND "),
            "",
            "",
            &values,
            &mut store::Unreadable::Refuse,
        )
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_row_whose_stored_text_is_not_json_matches_no_property_condition_and_fails_no_list() {
        let conn = family();
        conn.execute(
            "UPDATE items SET properties = '{\"rating\":' WHERE id = 'stranger'",
            [],
        )
        .unwrap();
        // The witness: before the guard SQLite raised `malformed JSON` for the
        // whole query, whatever the other rows held.
        let unguarded = conn.query_row(
            "SELECT json_extract(properties, '$.rating') FROM items WHERE id = 'stranger'",
            [],
            |row| row.get::<_, Option<String>>(0),
        );
        assert!(unguarded.is_err(), "{unguarded:?}");
        for (filter, wanted) in [
            ("properties.rating lte 5", vec!["child", "root"]),
            ("properties.rating gt 4", vec!["root"]),
            ("properties.rating eq 2", vec!["child"]),
            ("properties.rating neq 2", vec!["root"]),
            ("properties.note contains \"_\"", vec!["child"]),
            ("properties.rating exists", vec!["child", "root"]),
            ("properties.rating not_exists", vec!["grandchild"]),
            ("properties.flag eq true", vec!["root"]),
        ] {
            assert_eq!(ids(&conn, Some(filter), None), wanted, "{filter}");
        }
    }

    #[test]
    fn answers_each_condition_from_the_copy() {
        let conn = family();
        let filtered = |filter: &str| ids(&conn, Some(filter), None);
        assert_eq!(filtered("properties.rating lte 5"), ["child", "root"]);
        // A number against text: the server casts the property to a number
        // for a numeric bound but preserves text for numeric equality.
        assert_eq!(filtered("properties.rating gt 4"), ["root", "stranger"]);
        assert_eq!(filtered("properties.rating eq 9"), Vec::<String>::new());
        assert_eq!(filtered("properties.flag eq true"), ["root"]);
        assert_eq!(filtered("properties.note contains \"_\""), ["child"]);
        assert_eq!(
            filtered("properties.note starts_with \"a\""),
            ["child", "grandchild"]
        );
        assert_eq!(filtered("tags contains \"5.0\""), ["root"]);
        assert_eq!(filtered("tags contains 5"), Vec::<String>::new());
        assert_eq!(filtered("edge[references] eq \"stranger\""), ["child"]);
        assert_eq!(filtered("edge[parent-of] not_exists"), ["stranger"]);
    }

    #[test]
    fn numeric_equality_uses_the_same_double_as_numeric_bounds() {
        let conn = conn();
        let spellings = [
            "1000000000000000100",
            "-1000000000000000100",
            "9007199254740991",
            "9007199254740992",
            "9007199254740993",
            "-9007199254740993",
            "9223372036854775807",
            "-9223372036854775808",
            "1e18",
            "-1.25e-7",
            "0.125",
            "-0",
            "0",
        ];
        for (index, spelling) in spellings.iter().enumerate() {
            let properties = serde_json::from_str(&format!(r#"{{"n":{spelling}}}"#)).unwrap();
            let item = wire_item(
                &format!("n{index:02}"),
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                properties,
            );
            store::upsert_item(&conn, &item, None, &Indexing::default()).unwrap();
        }
        for spelling in spellings {
            let number = spelling.parse::<f64>().unwrap();
            let literal = if spelling == "-1.25e-7" {
                "-0.000000125"
            } else if spelling == "1e18" {
                "1000000000000000000"
            } else {
                spelling
            };
            for op in ["eq", "neq", "gte", "lte"] {
                let expected: Vec<String> = spellings
                    .iter()
                    .enumerate()
                    .filter(|(_, candidate)| {
                        let candidate = candidate.parse::<f64>().unwrap();
                        match op {
                            "eq" => candidate == number,
                            "neq" => candidate != number,
                            "gte" => candidate >= number,
                            _ => candidate <= number,
                        }
                    })
                    .map(|(index, _)| format!("n{index:02}"))
                    .collect();
                assert_eq!(
                    ids(&conn, Some(&format!("properties.n {op} {literal}")), None),
                    expected,
                    "{op} {literal}"
                );
            }
        }
        for (id, properties) in [
            ("text", json!({"other":"0"})),
            ("array", json!({"other":[]})),
            ("object", json!({"other":{}})),
            ("null", json!({"other":null})),
            ("missing", json!({})),
            ("false", json!({"other":false})),
            ("true", json!({"other":true})),
        ] {
            store::upsert_item(
                &conn,
                &wire_item(
                    id,
                    "core.note",
                    "active",
                    "2026-01-01T00:00:00Z",
                    properties,
                ),
                None,
                &Indexing::default(),
            )
            .unwrap();
        }
        assert_eq!(ids(&conn, Some("properties.other eq 0"), None), ["false"]);
        assert_eq!(ids(&conn, Some("properties.other eq true"), None), ["true"]);
        assert_eq!(
            ids(&conn, Some("properties.other eq \"0\""), None),
            ["text"]
        );
    }

    #[test]
    fn answers_a_backref_on_an_edge_type_the_copy_holds_whole() {
        let conn = family();
        let held = |filter: &str| ids_whole(&conn, Some(filter), None, &["parent-of"]);
        assert_eq!(
            held("backref[parent-of] exists"),
            ["child", "grandchild", "root"]
        );
        assert_eq!(held("backref[parent-of] not_exists"), ["stranger"]);
        assert_eq!(held("backref[parent-of] eq \"root\""), ["child"]);
        assert_eq!(
            held("backref[parent-of] neq \"root\""),
            ["grandchild", "root", "stranger"]
        );
        assert_eq!(
            held("backref[parent-of] exists AND backref[parent-of] neq \"root\""),
            ["grandchild", "root"]
        );
        // The outbound side of the same type reads the other end of each edge.
        assert_eq!(held("edge[parent-of] eq \"child\""), ["root"]);
    }

    #[test]
    fn refuses_a_backref_the_copy_cannot_answer_whole() {
        let conn = family();
        // The witness: the same expression is answered once the type is held.
        assert_eq!(
            ids_whole(
                &conn,
                Some("backref[references] exists"),
                None,
                &["references"]
            ),
            ["stranger"]
        );
        for (filter, whole) in [
            ("backref[references] exists", vec![]),
            ("backref[references] exists", vec!["parent-of".to_string()]),
            (
                "tags exists OR backref[x] neq \"a\"",
                vec!["references".to_string()],
            ),
        ] {
            let mut clauses = Vec::new();
            let mut values = Vec::new();
            let Err(CoreError::Invalid(message)) = narrow(
                Some(filter),
                None,
                &whole,
                &Catalog::empty(),
                &mut clauses,
                &mut values,
            ) else {
                panic!("{filter} was answered");
            };
            assert!(message.contains("backref"), "{message}");
        }
        // The grammar's own refusal comes first, as the server's does.
        assert!(matches!(
            narrow(
                Some("backref[x] exists AND title eq 1"),
                None,
                &["x".to_string()],
                &Catalog::empty(),
                &mut Vec::new(),
                &mut Vec::new()
            ),
            Err(CoreError::Validation { .. })
        ));
    }
}
