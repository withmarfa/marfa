//! The listing grammar's `filter` as values, so an app builds a filter, and
//! edits a saved one, without writing the server's grammar by hand. Text is
//! read with the parser `narrow` answers from, so the model takes exactly
//! what the server takes and refuses the rest with its message.
//!
//! `FilterExpression::decode(&expression.encode()?)` gives back the same
//! expression, but for the join of an expression of one condition, which the
//! text does not carry and which reads back as `All`. `encode` of a decoded
//! text is its canonical form: one space between tokens, a string quoted with
//! every quote and backslash escaped, and a number in its shortest decimal
//! spelling.

use serde::{Deserialize, Serialize};

use super::{Compare, Condition, Field, Literal, Op, Term, parse, refused, system_literal, term};
use crate::Result;
use crate::js;

/// The conditions of a filter and the one word that joins them: the grammar
/// joins every condition with `AND` or every one with `OR`, never both, and
/// has no grouping or negation of a group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterExpression {
    pub join: FilterJoin,
    pub conditions: Vec<FilterCondition>,
}

/// `All` joins the conditions with `AND`, `Any` with `OR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterJoin {
    All,
    Any,
}

/// One condition. `value` is `None` exactly where the operator takes none,
/// as `exists` and `not_exists` do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FilterCondition {
    pub field: FilterField,
    pub operator: FilterOperator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<FilterValue>,
}

/// What a condition reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterField {
    /// A column every item has.
    System {
        name: SystemField,
    },
    /// `properties.<name>`, read from the stored value whatever the type
    /// declares.
    Property {
        name: String,
    },
    /// `properties.<field>.<member>`: a member of the objects in the list
    /// `<field>` holds, compared with `eq` only.
    Member {
        field: String,
        member: String,
    },
    Tags,
    /// The group of the word in the item's status field.
    StatusGroup,
    /// `edge[<edge_type>]` or `backref[<edge_type>]`.
    Edge {
        edge_type: String,
        direction: EdgeDirection,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemField {
    State,
    Type,
    Source,
    OccurredAt,
    CreatedAt,
    UpdatedAt,
    Tier,
    Version,
    Id,
    SourceId,
}

/// `Outbound` for the edges an item draws, `Backref` for those drawn to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeDirection {
    Outbound,
    Backref,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOperator {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    StartsWith,
    Exists,
    NotExists,
}

/// A literal. The grammar has no `null`: `not_exists` asks for an absent or
/// null property.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

const OPERATORS: [FilterOperator; 10] = [
    FilterOperator::Eq,
    FilterOperator::Neq,
    FilterOperator::Gt,
    FilterOperator::Gte,
    FilterOperator::Lt,
    FilterOperator::Lte,
    FilterOperator::Contains,
    FilterOperator::StartsWith,
    FilterOperator::Exists,
    FilterOperator::NotExists,
];

impl FilterExpression {
    /// The expression's text in the listing grammar, refused with the
    /// server's `validation_error` where the server would refuse it: empty,
    /// longer than 2,048 UTF-16 code units, more than 10 conditions, or a
    /// field and operator it does not take together.
    pub fn encode(&self) -> Result<String> {
        let mut parts = Vec::with_capacity(self.conditions.len());
        for condition in &self.conditions {
            parts.push(condition.encode()?);
        }
        let joiner = match self.join {
            FilterJoin::All => " AND ",
            FilterJoin::Any => " OR ",
        };
        let text = parts.join(joiner);
        let read = Self::decode(&text)?;
        let same = read.conditions == self.conditions
            && (read.join == self.join || self.conditions.len() < 2);
        if !same {
            return Err(refused(format!(
                "The filter does not read back as it was built: {text}"
            )));
        }
        Ok(text)
    }

    /// The expression a text in the listing grammar holds, refused with the
    /// server's `validation_error` and message where the server refuses it.
    pub fn decode(text: &str) -> Result<FilterExpression> {
        let expression = parse(text)?;
        let conditions = expression
            .conditions
            .iter()
            .map(FilterCondition::read)
            .collect::<Result<Vec<_>>>()?;
        Ok(FilterExpression {
            join: if expression.any {
                FilterJoin::Any
            } else {
                FilterJoin::All
            },
            conditions,
        })
    }
}

impl FilterCondition {
    fn encode(&self) -> Result<String> {
        let field = self.field.encode()?;
        let operator = self.operator.name();
        match (self.operator.takes_value(), &self.value) {
            (true, Some(value)) => Ok(format!("{field} {operator} {}", value.encode()?)),
            (false, None) => Ok(format!("{field} {operator}")),
            (true, None) => Err(refused(format!("Operator \"{operator}\" takes a value"))),
            (false, Some(_)) => Err(refused(format!("Operator \"{operator}\" takes no value"))),
        }
    }

    fn read(condition: &Condition) -> Result<FilterCondition> {
        let (field, operator) = match &condition.term {
            Term::System { column, compare } => {
                system_literal(column, *compare, &condition.value)?;
                let name = SystemField::named(column)
                    .ok_or_else(|| refused(format!("Unknown field \"{column}\"")))?;
                (
                    FilterField::System { name },
                    FilterOperator::from_op(Op::Compare(*compare)),
                )
            }
            Term::Property { name, op } => (
                FilterField::Property { name: name.clone() },
                FilterOperator::from_op(*op),
            ),
            Term::Entry { field, member } => (
                FilterField::Member {
                    field: field.clone(),
                    member: member.clone(),
                },
                FilterOperator::Eq,
            ),
            Term::TagHeld => (FilterField::Tags, FilterOperator::Contains),
            Term::TagsPresent(present) => (
                FilterField::Tags,
                if *present {
                    FilterOperator::Exists
                } else {
                    FilterOperator::NotExists
                },
            ),
            Term::Edge {
                edge_type,
                backref,
                negated,
                to_item,
            } => (
                FilterField::Edge {
                    edge_type: edge_type.clone(),
                    direction: if *backref {
                        EdgeDirection::Backref
                    } else {
                        EdgeDirection::Outbound
                    },
                },
                match (negated, to_item) {
                    (false, true) => FilterOperator::Eq,
                    (true, true) => FilterOperator::Neq,
                    (false, false) => FilterOperator::Exists,
                    (true, false) => FilterOperator::NotExists,
                },
            ),
            Term::StatusGroup(op) => (FilterField::StatusGroup, FilterOperator::from_op(*op)),
        };
        let value = match &condition.value {
            Literal::Text(text) => Some(FilterValue::Text(text.clone())),
            Literal::Number(number) => Some(FilterValue::Number(*number)),
            Literal::Bool(flag) => Some(FilterValue::Bool(*flag)),
            Literal::Null => None,
        };
        Ok(FilterCondition {
            field,
            operator,
            value,
        })
    }
}

impl FilterField {
    /// The operators the grammar takes on this field, in the order the
    /// server's message lists them.
    pub fn operators(&self) -> Vec<FilterOperator> {
        OPERATORS
            .into_iter()
            .filter(|operator| term(self.parsed(), operator.op()).is_ok())
            .collect()
    }

    fn parsed(&self) -> Field {
        match self {
            FilterField::System { name } => Field::System(name.name()),
            FilterField::Property { name } => Field::Property(name.clone()),
            FilterField::Member { field, member } => Field::Entry {
                field: field.clone(),
                member: member.clone(),
            },
            FilterField::Tags => Field::Tags,
            FilterField::StatusGroup => Field::StatusGroup,
            FilterField::Edge {
                edge_type,
                direction,
            } => Field::Edge {
                edge_type: edge_type.clone(),
                backref: *direction == EdgeDirection::Backref,
            },
        }
    }

    fn encode(&self) -> Result<String> {
        Ok(match self {
            FilterField::System { name } => name.name().to_string(),
            FilterField::Property { name } => format!("properties.{}", property_name(name)?),
            FilterField::Member { field, member } => format!(
                "properties.{}.{}",
                property_name(field)?,
                property_name(member)?
            ),
            FilterField::Tags => "tags".into(),
            FilterField::StatusGroup => super::STATUS_GROUP.into(),
            FilterField::Edge {
                edge_type,
                direction,
            } => match direction {
                EdgeDirection::Outbound => format!("edge[{edge_type}]"),
                EdgeDirection::Backref => format!("backref[{edge_type}]"),
            },
        })
    }
}

/// A property or member name as the grammar takes it, refused with the
/// server's message otherwise.
fn property_name(name: &str) -> Result<&str> {
    let mut chars = name.chars();
    let valid = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid {
        Ok(name)
    } else {
        Err(refused(format!(
            "Invalid property name \"{name}\". Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/"
        )))
    }
}

impl SystemField {
    fn name(self) -> &'static str {
        match self {
            SystemField::State => "state",
            SystemField::Type => "type",
            SystemField::Source => "source",
            SystemField::OccurredAt => "occurred_at",
            SystemField::CreatedAt => "created_at",
            SystemField::UpdatedAt => "updated_at",
            SystemField::Tier => "tier",
            SystemField::Version => "version",
            SystemField::Id => "id",
            SystemField::SourceId => "source_id",
        }
    }

    fn named(column: &str) -> Option<SystemField> {
        [
            SystemField::State,
            SystemField::Type,
            SystemField::Source,
            SystemField::OccurredAt,
            SystemField::CreatedAt,
            SystemField::UpdatedAt,
            SystemField::Tier,
            SystemField::Version,
            SystemField::Id,
            SystemField::SourceId,
        ]
        .into_iter()
        .find(|field| field.name() == column)
    }
}

impl FilterOperator {
    /// Whether the operator compares with a value: all but `exists` and
    /// `not_exists` do.
    pub fn takes_value(self) -> bool {
        matches!(self.op(), Op::Compare(_))
    }

    fn op(self) -> Op {
        match self {
            FilterOperator::Eq => Op::Compare(Compare::Eq),
            FilterOperator::Neq => Op::Compare(Compare::Neq),
            FilterOperator::Gt => Op::Compare(Compare::Gt),
            FilterOperator::Gte => Op::Compare(Compare::Gte),
            FilterOperator::Lt => Op::Compare(Compare::Lt),
            FilterOperator::Lte => Op::Compare(Compare::Lte),
            FilterOperator::Contains => Op::Compare(Compare::Contains),
            FilterOperator::StartsWith => Op::Compare(Compare::StartsWith),
            FilterOperator::Exists => Op::Exists,
            FilterOperator::NotExists => Op::NotExists,
        }
    }

    fn from_op(op: Op) -> FilterOperator {
        OPERATORS
            .into_iter()
            .find(|operator| operator.op() == op)
            .expect("every operator the parser reads has a model operator")
    }

    fn name(self) -> &'static str {
        self.op().name()
    }
}

impl FilterValue {
    fn encode(&self) -> Result<String> {
        match self {
            FilterValue::Text(text) => Ok(format!(
                "\"{}\"",
                text.replace('\\', "\\\\").replace('"', "\\\"")
            )),
            // Rust writes a float in fixed notation with the fewest digits
            // that read back as the same double, which the grammar's
            // number, with no exponent, takes.
            FilterValue::Number(number) => {
                if !number.is_finite() {
                    return Err(refused(format!(
                        "Number out of range \"{}\"",
                        js::number(*number)
                    )));
                }
                Ok(number.to_string())
            }
            FilterValue::Bool(flag) => Ok(flag.to_string()),
        }
    }
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
