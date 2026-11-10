//! The listing grammar as a tree. The parser refuses what the server refuses, with its code. This module names no table and no engine.

use crate::catalog::STATUS_GROUPS;
use crate::error::{Result, RuleError};
use crate::number;

mod model;

pub use model::{
    EdgeDirection, FilterCondition, FilterExpression, FilterField, FilterJoin, FilterOperator,
    FilterValue, SystemField,
};

const MAX_INPUT_LENGTH: usize = 2048;
const MAX_CONDITIONS: usize = 10;

pub const SYSTEM_FIELDS: [&str; 10] = [
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

pub const STATUS_GROUP: &str = "status_group";

pub const PART: &str = "part";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reads {
    pub status: bool,
    pub relational: bool,
    /// `state`, `updated_at` or `version`: a column a move between states changes.
    pub moved: bool,
}

const MOVED_FIELDS: [&str; 3] = ["state", "updated_at", "version"];

pub fn reads(filter: &str) -> Result<Reads> {
    let expression = parse(filter)?;
    let mut reads = Reads::default();
    for condition in &expression.conditions {
        match condition.term {
            Term::StatusGroup(_) => reads.status = true,
            Term::Edge { .. } | Term::Part(_) => reads.relational = true,
            Term::System { column, .. } if MOVED_FIELDS.contains(&column) => reads.moved = true,
            Term::TagHeld
            | Term::TagsPresent(_)
            | Term::System { .. }
            | Term::Property { .. }
            | Term::Entry { .. } => {}
        }
    }
    Ok(reads)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Text(String),
    Number(f64),
    Bool(bool),
    /// No value: the operator takes none. A `null` in the expression is refused, never read as this.
    Null,
}

impl Literal {
    /// The text a pattern operator matches.
    pub fn text(&self) -> String {
        match self {
            Literal::Text(text) => text.clone(),
            Literal::Number(number) => number::text(*number),
            Literal::Bool(flag) => flag.to_string(),
            Literal::Null => "null".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Compare {
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
pub enum Op {
    Compare(Compare),
    Exists,
    NotExists,
}

impl Op {
    pub(crate) fn parse(name: &str) -> Option<Op> {
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

    pub(crate) fn name(self) -> &'static str {
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

#[derive(Debug, Clone, PartialEq)]
pub enum Term {
    System {
        column: &'static str,
        compare: Compare,
    },
    Property {
        name: String,
        op: Op,
    },
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
    StatusGroup(Op),
    Part(Compare),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Condition {
    pub term: Term,
    pub value: Literal,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Expression {
    pub conditions: Vec<Condition>,
    pub any: bool,
}

impl Expression {
    pub fn reads_status(&self) -> bool {
        self.conditions
            .iter()
            .any(|condition| matches!(condition.term, Term::StatusGroup(_)))
    }
}

/// A time column compared as an instant takes a timestamp, which is normalized; anything else is refused.
pub fn system_literal(column: &str, compare: Compare, value: &Literal) -> Result<Literal> {
    if !matches!(column, "created_at" | "updated_at" | "occurred_at")
        || matches!(compare, Compare::Contains | Compare::StartsWith)
    {
        return Ok(value.clone());
    }
    let Literal::Text(text) = value else {
        return Err(crate::time::invalid(column, "expected a timestamp"));
    };
    Ok(Literal::Text(crate::time::normalize_bound(text, column)?))
}

pub(crate) fn refused(message: impl Into<String>) -> RuleError {
    RuleError::validation(message)
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

/// The type is anything but a closing bracket or whitespace, and not nothing.
fn edge_ref(word: &str) -> Option<(bool, &str)> {
    let (backref, rest) = if let Some(rest) = word.strip_prefix("edge[") {
        (false, rest)
    } else {
        (true, word.strip_prefix("backref[")?)
    };
    let edge_type = rest.strip_suffix(']')?;
    if edge_type.is_empty() || edge_type.contains(']') || edge_type.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some((backref, edge_type))
}

fn tokenize(input: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = input.chars().collect();
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
                if let ('\\', Some(escaped @ ('"' | '\\'))) = (chars[i], chars.get(i + 1).copied())
                {
                    value.push(escaped);
                    i += 2;
                } else {
                    value.push(chars[i]);
                    i += 1;
                }
            }
            if i >= chars.len() {
                return Err(refused(format!(
                    "Unterminated string starting at position {}",
                    start
                )));
            }
            i += 1;
            tokens.push(Token {
                kind: TokenKind::Text(value),
                raw: raw(start, i),
                pos: start,
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
            // Enough digits read as infinity, which is refused.
            let number = text
                .parse::<f64>()
                .ok()
                .filter(|number| number.is_finite())
                .ok_or_else(|| {
                    refused(format!(
                        "Number out of range \"{text}\" at position {}",
                        start
                    ))
                })?;
            tokens.push(Token {
                kind: TokenKind::Number(number),
                raw: text,
                pos: start,
            });
            continue;
        }
        if ch == 'e' || ch == 'b' {
            let end = chars[i..]
                .iter()
                .position(|c| c.is_whitespace())
                .map_or(chars.len(), |offset| i + offset);
            let word = raw(i, end);
            if edge_ref(&word).is_some() {
                tokens.push(Token {
                    kind: TokenKind::Identifier(word.clone()),
                    raw: word,
                    pos: i,
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
                pos: start,
            });
            continue;
        }
        return Err(refused(format!(
            "Unexpected character '{ch}' at position {}",
            i
        )));
    }
    Ok(tokens)
}

pub(crate) enum Field {
    System(&'static str),
    Property(String),
    Entry { field: String, member: String },
    Tags,
    StatusGroup,
    Part,
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
    if name == PART {
        return Ok(Field::Part);
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
        "Unknown field \"{name}\" at position {}. Valid system fields: {}. Use \"properties.<field>\" for custom fields, \"tags\" for tag filtering, \"status_group\" for a status group, or \"{PART}\" for the parts of other items.",
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

pub(crate) fn term(field: Field, op: Op) -> Result<Term> {
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
        Field::Part => match op {
            Op::Compare(compare @ (Compare::Eq | Compare::Neq)) => Term::Part(compare),
            _ => {
                return Err(refused(format!(
                    "Operator \"{}\" is not valid for \"{PART}\". Use: eq, neq, with true or false",
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

/// A comparison with null is unknown in SQL and never matches, so the literal is refused and the operator that asks the question is named.
fn refuse_null(token: &Token, term: &Term, op: Op) -> RuleError {
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
        Term::Part(_) => format!("{never} Compare \"{PART}\" with true or false"),
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

pub fn parse(input: &str) -> Result<Expression> {
    parse_with(input, field)
}

/// The fields of a table's rows: `values.<column>`, `id` and `updated_at`.
pub const ROW_FIELDS: [&str; 2] = ["id", "updated_at"];

/// An expression over a table's rows, where `values.<column>` reads as a property term.
pub fn parse_rows(input: &str) -> Result<Expression> {
    parse_with(input, row_field)
}

fn row_field(token: &Token) -> Result<Field> {
    let TokenKind::Identifier(name) = &token.kind else {
        return Err(refused(format!(
            "Expected field name at position {}, got {}",
            token.pos, token.raw
        )));
    };
    if let Some(column) = name.strip_prefix("values.") {
        let mut chars = column.chars();
        let valid = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(refused(format!(
                "Invalid column name \"{column}\" at position {}",
                token.pos
            )));
        }
        return Ok(Field::Property(column.to_string()));
    }
    if let Some(column) = SYSTEM_FIELDS
        .iter()
        .find(|column| **column == name && ROW_FIELDS.contains(column))
    {
        return Ok(Field::System(column));
    }
    Err(refused(format!(
        "Unknown field \"{name}\" at position {}. A row's fields are values.<column>, id and updated_at.",
        token.pos
    )))
}

fn parse_with(input: &str, field: fn(&Token) -> Result<Field>) -> Result<Expression> {
    if input.chars().all(char::is_whitespace) {
        return Err(refused("Filter expression cannot be empty"));
    }
    let length = input.chars().count();
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
            if matches!(term, Term::Part(_)) && !matches!(literal, Literal::Bool(_)) {
                return Err(refused(format!(
                    "\"{PART}\" compares with true or false, not {}, at position {}",
                    token.raw, token.pos
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
    use super::*;
    use crate::error::Code;

    fn code(input: &str) -> Option<String> {
        match parse(input) {
            Ok(_) => None,
            Err(error) if error.code == Code::ValidationError => {
                Some(error.code.as_str().to_string())
            }
            Err(other) => Some(format!("{other:?}")),
        }
    }

    fn message(input: &str) -> String {
        match parse(input) {
            Err(error) if error.code == Code::ValidationError => error.message,
            other => panic!("{input:?} was not refused: {other:?}"),
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
            let Err(RuleError { code, message, .. }) = parse(&input) else {
                panic!("{input} was accepted");
            };
            assert_eq!(code, Code::ValidationError);
            assert!(message.contains(&format!("\"{op} null\" never matches")));
            assert!(message.contains("\"not_exists\""), "{message}");
        }
        for (input, advice) in [
            ("edge[about] eq null", "rows that draw no edge"),
            ("source_id eq null", "Compare \"source_id\" with a value"),
            ("tags contains null", "Name the tag to look for"),
            ("state eq \"a\" OR properties.n neq null", "never matches"),
        ] {
            let Err(RuleError { message, .. }) = parse(input) else {
                panic!("{input} was accepted");
            };
            assert!(message.contains(advice), "{input}: {message}");
        }
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
    fn counts_the_length_in_characters() {
        let emoji = |count: usize| format!("id eq \"{}\"", "\u{1F426}".repeat(count));
        assert_eq!(emoji(2040).chars().count(), 2048);
        assert!(parse(&emoji(2040)).is_ok());
        assert_eq!(emoji(2041).chars().count(), 2049);
        assert!(code(&emoji(2041)).is_some());
    }

    #[test]
    fn ends_an_edge_reference_at_unicode_whitespace() {
        let parsed = parse("edge[a\u{feff}b] exists").unwrap();
        assert!(matches!(
            &parsed.conditions[0].term,
            Term::Edge { edge_type, .. } if edge_type == "a\u{feff}b"
        ));
        assert!(code("edge[a\u{85}b] exists").is_some());
    }

    #[test]
    fn names_a_position_in_characters() {
        assert_eq!(
            message("id eq \"\u{1F426}\" OR x eq 1"),
            "Unknown field \"x\" at position 13. Valid system fields: state, type, source, occurred_at, created_at, updated_at, tier, version, id, source_id. Use \"properties.<field>\" for custom fields, \"tags\" for tag filtering, \"status_group\" for a status group, or \"part\" for the parts of other items."
        );
        assert_eq!(
            message("id eq \"\u{1F426}\" \u{e9}"),
            "Unexpected character '\u{e9}' at position 10"
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

    #[test]
    fn a_part_term_takes_only_eq_and_neq_with_true_or_false() {
        for (filter, said) in [
            (
                "part contains true",
                "Operator \"contains\" is not valid for \"part\". Use: eq, neq, with true or false",
            ),
            (
                "part exists",
                "Operator \"exists\" is not valid for \"part\". Use: eq, neq, with true or false",
            ),
            (
                "part gt true",
                "Operator \"gt\" is not valid for \"part\". Use: eq, neq, with true or false",
            ),
            (
                "part eq 1",
                "\"part\" compares with true or false, not 1, at position 8",
            ),
            (
                "part eq \"true\"",
                "\"part\" compares with true or false, not \"true\", at position 8",
            ),
            (
                "part eq null",
                "Null is not a value to compare with, so \"eq null\" never matches at position 8. Compare \"part\" with true or false",
            ),
        ] {
            assert_eq!(message(filter), said, "{filter}");
        }
        assert!(message("parts eq true").ends_with(
            "Use \"properties.<field>\" for custom fields, \"tags\" for tag filtering, \"status_group\" for a status group, or \"part\" for the parts of other items."
        ));
    }

    #[test]
    fn a_row_filter_reads_columns_and_its_own_fields_and_nothing_an_item_has() {
        let expression =
            parse_rows("values.amount gt 5 AND updated_at gte \"2026-01-01\"").unwrap();
        assert_eq!(
            expression.conditions[0].term,
            Term::Property {
                name: "amount".into(),
                op: Op::Compare(Compare::Gt)
            }
        );
        assert!(matches!(
            expression.conditions[1].term,
            Term::System {
                column: "updated_at",
                ..
            }
        ));
        for refused in [
            "properties.amount eq 1",
            "state eq \"active\"",
            "tags exists",
            "values. eq 1",
            "values.a.b eq 1",
        ] {
            assert!(parse_rows(refused).is_err(), "{refused}");
        }
    }
}
