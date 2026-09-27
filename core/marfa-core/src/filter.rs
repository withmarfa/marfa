//! The server's listing grammar, the `filter` of `GET /items` and
//! `GET /search`, answered from the working copy.
//!
//! A port rather than a lookalike: the parser refuses what the server's
//! refuses, with the code it refuses with, and each condition compiles to the
//! SQL the server runs, bound the way the server's driver binds it. A
//! condition read even slightly otherwise answers one set of rows offline and
//! another online for the same question.

use serde_json::{Number, Value};

use crate::Result;
use crate::error::CoreError;
use crate::js;
use crate::query::escape_like;

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

/// The edge type `beneath` walks: an edge's source is the parent and its
/// target the child.
const PARENT_OF: &str = "parent-of";

/// Narrows a local read by a listing-grammar expression and by `beneath`,
/// each one clause ANDed with the rest, as the server ANDs its `filter` with
/// its other parameters. An expression the grammar refuses is refused here,
/// never dropped, and so is one the copy cannot answer as the server would.
pub(crate) fn narrow(
    filter: Option<&str>,
    beneath: Option<&str>,
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
) -> Result<()> {
    if let Some(filter) = filter {
        clauses.push(parse(filter)?.clause(values)?);
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

#[derive(Debug, Clone, PartialEq)]
enum Literal {
    Text(String),
    Number(f64),
    Bool(bool),
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
    TagHeld,
    TagsPresent(bool),
    Edge {
        edge_type: String,
        backref: bool,
        negated: bool,
        to_item: bool,
    },
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
    fn clause(&self, values: &mut Vec<Value>) -> Result<String> {
        let joiner = if self.any { " OR " } else { " AND " };
        let parts = self
            .conditions
            .iter()
            .map(|condition| condition.clause(values))
            .collect::<Result<Vec<String>>>()?;
        Ok(format!("({})", parts.join(joiner)))
    }
}

impl Condition {
    fn clause(&self, values: &mut Vec<Value>) -> Result<String> {
        Ok(match &self.term {
            Term::System { column, compare } => {
                compared(&format!("items.{column}"), *compare, &self.value, values)
            }
            Term::Property { name, op } => {
                values.push(Value::String(format!("$.{name}")));
                let extract = "json_extract(items.properties, ?)";
                match op {
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
                }
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
            // The copy holds only the edges its items draw, not those drawn
            // to them from outside the slice.
            Term::Edge { backref: true, .. } => {
                return Err(CoreError::Invalid(
                    "a backref condition is not answered from a working copy, which holds the edges its items draw but not every edge drawn to them: ask the server".into(),
                ));
            }
            Term::Edge {
                edge_type,
                backref: false,
                negated,
                to_item,
            } => {
                values.push(Value::String(edge_type.clone()));
                let other = if *to_item {
                    values.push(self.value.bound());
                    " AND e.target_id = ?"
                } else {
                    ""
                };
                format!(
                    "{}EXISTS (SELECT 1 FROM edges e WHERE e.source_id = items.id AND e.edge_type = ?{other})",
                    if *negated { "NOT " } else { "" }
                )
            }
        })
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

/// JavaScript's `\s`, which is where the server ends an edge reference's
/// word.
fn is_js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
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
    if edge_type.is_empty() || edge_type.contains(']') || edge_type.chars().any(is_js_space) {
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
                .position(|c| is_js_space(*c))
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
    Tags,
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
    if let Some(path) = name.strip_prefix("properties.") {
        if path.is_empty() {
            return Err(refused(format!(
                "Missing property name after \"properties.\" at position {}",
                token.pos
            )));
        }
        if path.contains('.') {
            return Err(refused(format!(
                "Nested property paths are not supported in v1. Use \"properties.<field>\" at position {}",
                token.pos
            )));
        }
        let mut chars = path.chars();
        let valid = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(refused(format!(
                "Invalid property name \"{path}\". Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/"
            )));
        }
        return Ok(Field::Property(path.to_string()));
    }
    if let Some(column) = SYSTEM_FIELDS.iter().find(|column| **column == name) {
        return Ok(Field::System(column));
    }
    Err(refused(format!(
        "Unknown field \"{name}\" at position {}. Valid system fields: {}. Use \"properties.<field>\" for custom fields, or \"tags\" for tag filtering.",
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
    })
}

fn value(token: &Token) -> Result<Literal> {
    Ok(match &token.kind {
        TokenKind::Text(text) => Literal::Text(text.clone()),
        TokenKind::Number(number) => Literal::Number(*number),
        TokenKind::Bool(flag) => Literal::Bool(*flag),
        TokenKind::Null => Literal::Null,
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
    if input.trim().is_empty() {
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
            let literal = value(expect(&tokens, pos, "value")?)?;
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
    fn refuses_what_the_server_refuses_with_its_code() {
        let refusal = Some("validation_error".to_string());
        for input in [
            "",
            "  \t ",
            "properties.a.b eq 1",
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
    fn bounds_the_conditions_and_the_length_one_past_where_they_stop() {
        let ten = ["tags exists"; 10].join(" AND ");
        assert_eq!(parse(&ten).unwrap().conditions.len(), 10);
        assert!(code(&format!("{ten} AND tags exists")).is_some());
        let at = |length: usize| format!("id eq \"{}\"", "é".repeat(length - 8));
        assert!(parse(&at(2048)).is_ok());
        assert!(code(&at(2049)).is_some());
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
        // 1029 characters and 2066 units: refused by the units alone.
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
            "Unknown field \"x\" at position 14. Valid system fields: state, type, source, occurred_at, created_at, updated_at, tier, version, id, source_id. Use \"properties.<field>\" for custom fields, or \"tags\" for tag filtering."
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
            // A cycle the copy can hold whatever the server refuses, and
            // the walk has to end on it.
            ("3", "grandchild", "root", "parent-of"),
            ("4", "child", "stranger", "references"),
        ] {
            store::upsert_edge(&conn, &wire_edge(id, source, target, edge_type)).unwrap();
        }
        conn
    }

    fn ids(conn: &Connection, filter: Option<&str>, beneath: Option<&str>) -> Vec<String> {
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        narrow(filter, beneath, &mut clauses, &mut values).unwrap();
        let mut ids: Vec<String> =
            store::items_where(conn, &clauses.join(" AND "), "", "", &values)
                .unwrap()
                .into_iter()
                .map(|item| item.id)
                .collect();
        ids.sort();
        ids
    }

    #[test]
    fn answers_each_condition_from_the_copy() {
        let conn = family();
        let filtered = |filter: &str| ids(&conn, Some(filter), None);
        assert_eq!(filtered("properties.rating lte 5"), ["child", "root"]);
        // A number against text: the server casts the property to a number
        // for a numeric bound and compares it raw for equality.
        assert_eq!(filtered("properties.rating gt 4"), ["root", "stranger"]);
        assert_eq!(filtered("properties.rating eq 9"), Vec::<String>::new());
        assert_eq!(filtered("properties.flag eq true"), ["root"]);
        assert_eq!(filtered("properties.note contains \"_\""), ["child"]);
        assert_eq!(
            filtered("properties.note starts_with \"a\""),
            ["child", "grandchild"]
        );
        assert_eq!(filtered("properties.note eq null"), Vec::<String>::new());
        assert_eq!(filtered("tags contains \"5.0\""), ["root"]);
        assert_eq!(filtered("tags contains 5"), Vec::<String>::new());
        assert_eq!(filtered("edge[references] eq \"stranger\""), ["child"]);
        assert_eq!(filtered("edge[parent-of] not_exists"), ["stranger"]);
    }

    #[test]
    fn refuses_a_backref_the_copy_cannot_answer_whole() {
        for filter in [
            "backref[parent-of] exists",
            "tags exists OR backref[x] neq \"a\"",
        ] {
            let mut clauses = Vec::new();
            let mut values = Vec::new();
            assert!(matches!(
                narrow(Some(filter), None, &mut clauses, &mut values),
                Err(CoreError::Invalid(_))
            ));
        }
        // The grammar's own refusal comes first, as the server's does.
        assert!(matches!(
            narrow(
                Some("backref[x] exists AND title eq 1"),
                None,
                &mut Vec::new(),
                &mut Vec::new()
            ),
            Err(CoreError::Validation { .. })
        ));
    }

    #[test]
    fn beneath_is_the_item_and_what_it_reaches_along_parent_of() {
        let conn = family();
        assert_eq!(
            ids(&conn, None, Some("child")),
            ["child", "grandchild", "root"]
        );
        assert_eq!(ids(&conn, None, Some("stranger")), ["stranger"]);
        assert_eq!(ids(&conn, None, Some("absent")), Vec::<String>::new());
        assert_eq!(
            ids(&conn, Some("properties.rating exists"), Some("child")),
            ["child", "root"]
        );
    }
}
