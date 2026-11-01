//! The listing grammar's `filter` as values: an app builds a filter, and
//! edits a saved one, without writing the server's grammar by hand.

use crate::MarfaError;

/// The conditions of a filter and the one word that joins them. The grammar
/// joins every condition with `AND` or every one with `OR`, never both.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FilterExpression {
    pub join: FilterJoin,
    pub conditions: Vec<FilterCondition>,
}

/// `All` joins the conditions with `AND`, `Any` with `OR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FilterJoin {
    All,
    Any,
}

/// One condition. `value` is `nil` exactly where the operator takes none.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FilterCondition {
    pub field: FilterField,
    pub operator: FilterOperator,
    pub value: Option<FilterValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum FilterField {
    System {
        name: SystemField,
    },
    /// `properties.<name>`.
    Property {
        name: String,
    },
    /// `properties.<field>.<member>`, compared with `eq` only.
    Member {
        field: String,
        member: String,
    },
    Tags,
    StatusGroup,
    /// Whether the item is a part of another, compared with `eq` or `neq`
    /// and a boolean.
    Part,
    Edge {
        edge_type: String,
        direction: EdgeDirection,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EdgeDirection {
    Outbound,
    Backref,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
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

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FilterValue {
    Text { value: String },
    Number { value: f64 },
    Bool { value: bool },
}

/// The expression's text in the listing grammar, refused with the server's
/// `validation_error` where the server would refuse it.
#[uniffi::export]
pub fn encode_filter(expression: FilterExpression) -> Result<String, MarfaError> {
    Ok(marfa_core::FilterExpression::from(expression).encode()?)
}

/// The expression a text in the listing grammar holds, refused with the
/// server's `validation_error` and message where the server refuses it.
#[uniffi::export]
pub fn decode_filter(text: String) -> Result<FilterExpression, MarfaError> {
    Ok(marfa_core::FilterExpression::decode(&text)?.into())
}

/// The operators the grammar takes on a field.
#[uniffi::export]
pub fn filter_operators(field: FilterField) -> Vec<FilterOperator> {
    marfa_core::FilterField::from(field)
        .operators()
        .into_iter()
        .map(FilterOperator::from)
        .collect()
}

macro_rules! same_enum {
    ($name:ident { $($variant:ident),* $(,)? }) => {
        impl From<$name> for marfa_core::$name {
            fn from(value: $name) -> Self {
                match value {
                    $($name::$variant => marfa_core::$name::$variant,)*
                }
            }
        }
        impl From<marfa_core::$name> for $name {
            fn from(value: marfa_core::$name) -> Self {
                match value {
                    $(marfa_core::$name::$variant => $name::$variant,)*
                }
            }
        }
    };
}

same_enum!(FilterJoin { All, Any });
same_enum!(EdgeDirection { Outbound, Backref });
same_enum!(SystemField {
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
});
same_enum!(FilterOperator {
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
});

impl From<FilterExpression> for marfa_core::FilterExpression {
    fn from(value: FilterExpression) -> Self {
        marfa_core::FilterExpression {
            join: value.join.into(),
            conditions: value.conditions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<marfa_core::FilterExpression> for FilterExpression {
    fn from(value: marfa_core::FilterExpression) -> Self {
        FilterExpression {
            join: value.join.into(),
            conditions: value.conditions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FilterCondition> for marfa_core::FilterCondition {
    fn from(value: FilterCondition) -> Self {
        marfa_core::FilterCondition {
            field: value.field.into(),
            operator: value.operator.into(),
            value: value.value.map(Into::into),
        }
    }
}

impl From<marfa_core::FilterCondition> for FilterCondition {
    fn from(value: marfa_core::FilterCondition) -> Self {
        FilterCondition {
            field: value.field.into(),
            operator: value.operator.into(),
            value: value.value.map(Into::into),
        }
    }
}

impl From<FilterField> for marfa_core::FilterField {
    fn from(value: FilterField) -> Self {
        use marfa_core::FilterField as F;
        match value {
            FilterField::System { name } => F::System { name: name.into() },
            FilterField::Property { name } => F::Property { name },
            FilterField::Member { field, member } => F::Member { field, member },
            FilterField::Tags => F::Tags,
            FilterField::StatusGroup => F::StatusGroup,
            FilterField::Part => F::Part,
            FilterField::Edge {
                edge_type,
                direction,
            } => F::Edge {
                edge_type,
                direction: direction.into(),
            },
        }
    }
}

impl From<marfa_core::FilterField> for FilterField {
    fn from(value: marfa_core::FilterField) -> Self {
        use marfa_core::FilterField as F;
        match value {
            F::System { name } => FilterField::System { name: name.into() },
            F::Property { name } => FilterField::Property { name },
            F::Member { field, member } => FilterField::Member { field, member },
            F::Tags => FilterField::Tags,
            F::StatusGroup => FilterField::StatusGroup,
            F::Part => FilterField::Part,
            F::Edge {
                edge_type,
                direction,
            } => FilterField::Edge {
                edge_type,
                direction: direction.into(),
            },
        }
    }
}

impl From<FilterValue> for marfa_core::FilterValue {
    fn from(value: FilterValue) -> Self {
        match value {
            FilterValue::Text { value } => marfa_core::FilterValue::Text(value),
            FilterValue::Number { value } => marfa_core::FilterValue::Number(value),
            FilterValue::Bool { value } => marfa_core::FilterValue::Bool(value),
        }
    }
}

impl From<marfa_core::FilterValue> for FilterValue {
    fn from(value: marfa_core::FilterValue) -> Self {
        match value {
            marfa_core::FilterValue::Text(value) => FilterValue::Text { value },
            marfa_core::FilterValue::Number(value) => FilterValue::Number { value },
            marfa_core::FilterValue::Bool(value) => FilterValue::Bool { value },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_and_decodes_through_the_binding_types() {
        let expression = FilterExpression {
            join: FilterJoin::Any,
            conditions: vec![
                FilterCondition {
                    field: FilterField::Member {
                        field: "emails".into(),
                        member: "address".into(),
                    },
                    operator: FilterOperator::Eq,
                    value: Some(FilterValue::Text {
                        value: "say \"hi\", \u{1F389}".into(),
                    }),
                },
                FilterCondition {
                    field: FilterField::Edge {
                        edge_type: "in-folder".into(),
                        direction: EdgeDirection::Backref,
                    },
                    operator: FilterOperator::NotExists,
                    value: None,
                },
                FilterCondition {
                    field: FilterField::System {
                        name: SystemField::Version,
                    },
                    operator: FilterOperator::Gte,
                    value: Some(FilterValue::Number { value: 2.5 }),
                },
            ],
        };
        let text = encode_filter(expression.clone()).unwrap();
        assert_eq!(
            text,
            "properties.emails.address eq \"say \\\"hi\\\", \u{1F389}\" OR backref[in-folder] not_exists OR version gte 2.5"
        );
        assert_eq!(decode_filter(text).unwrap(), expression);
        assert_eq!(
            filter_operators(FilterField::Tags),
            [
                FilterOperator::Contains,
                FilterOperator::Exists,
                FilterOperator::NotExists
            ]
        );
    }

    #[test]
    fn refuses_as_a_validation_error_with_the_servers_message() {
        match decode_filter("tags eq \"x\"".into()) {
            Err(MarfaError::Validation { code, message }) => {
                assert_eq!(code, "validation_error");
                assert_eq!(
                    message,
                    "validation (validation_error): Operator \"eq\" is not valid for \"tags\". Use: contains, exists, not_exists"
                );
            }
            other => panic!("expected a validation refusal, got {other:?}"),
        }
    }
}
