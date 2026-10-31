use serde::Deserialize;
use serde_json::json;

use super::*;
use crate::error::CoreError;

/// The cases the server's parser is held to in
/// `packages/server/src/storage/filter-fixtures.test.ts`, so the two cannot
/// drift.
const SHARED: &str = include_str!("../../../../conformance/fixtures/filter-expressions.json");

#[derive(Deserialize)]
struct Shared {
    canonical: Vec<Canonical>,
    variants: Vec<Variant>,
    refused: Vec<Refused>,
}

#[derive(Deserialize)]
struct Canonical {
    description: String,
    text: String,
    expression: FilterExpression,
}

#[derive(Deserialize)]
struct Variant {
    description: String,
    text: String,
    canonical: String,
}

#[derive(Deserialize)]
struct Refused {
    description: String,
    text: String,
    code: String,
    message: String,
}

fn shared() -> Shared {
    serde_json::from_str(SHARED).unwrap()
}

fn refusal(result: Result<impl std::fmt::Debug>) -> (String, String) {
    match result {
        Err(CoreError::Validation { code, message }) => (code, message),
        other => panic!("expected a validation refusal, got {other:?}"),
    }
}

fn condition(
    field: FilterField,
    operator: FilterOperator,
    value: Option<FilterValue>,
) -> FilterExpression {
    FilterExpression {
        join: FilterJoin::All,
        conditions: vec![FilterCondition {
            field,
            operator,
            value,
        }],
    }
}

fn text(value: &str) -> Option<FilterValue> {
    Some(FilterValue::Text(value.into()))
}

fn property(name: &str) -> FilterField {
    FilterField::Property { name: name.into() }
}

#[test]
fn encodes_and_decodes_every_shared_case_exactly() {
    for case in shared().canonical {
        assert_eq!(
            case.expression.encode().unwrap(),
            case.text,
            "{}",
            case.description
        );
        assert_eq!(
            FilterExpression::decode(&case.text).unwrap(),
            case.expression,
            "{}",
            case.description
        );
    }
}

#[test]
fn writes_every_spelling_of_one_expression_in_its_canonical_form() {
    for case in shared().variants {
        let read = FilterExpression::decode(&case.text).unwrap();
        assert_eq!(
            read.encode().unwrap(),
            case.canonical,
            "{}",
            case.description
        );
        assert_eq!(
            read,
            FilterExpression::decode(&case.canonical).unwrap(),
            "{}",
            case.description
        );
    }
}

#[test]
fn refuses_what_the_server_refuses_with_its_message() {
    for case in shared().refused {
        assert_eq!(
            refusal(FilterExpression::decode(&case.text)),
            (case.code, case.message),
            "{}",
            case.description
        );
    }
}

#[test]
fn reads_back_every_model_it_writes() {
    let values = [
        FilterValue::Text(String::new()),
        FilterValue::Text("plain".into()),
        FilterValue::Text("\"".into()),
        FilterValue::Text("\\\"".into()),
        FilterValue::Text("\\\\\"x".into()),
        FilterValue::Text("a\\b".into()),
        FilterValue::Text("\"quoted\", with \\ and \u{1F389}\u{200D}\u{1F525}".into()),
        FilterValue::Text(" AND state eq \"x\" OR ".into()),
        FilterValue::Text("\u{feff}\u{85}\n\r\t".into()),
        FilterValue::Number(0.0),
        FilterValue::Number(-0.0),
        FilterValue::Number(0.1 + 0.2),
        FilterValue::Number(-1e-7),
        FilterValue::Number(f64::MAX),
        FilterValue::Number(f64::MIN_POSITIVE),
        FilterValue::Number(5e-324),
        FilterValue::Number(9_007_199_254_740_993.0),
        FilterValue::Bool(true),
        FilterValue::Bool(false),
    ];
    let fields = [
        property("title"),
        FilterField::System {
            name: SystemField::Source,
        },
        FilterField::Edge {
            edge_type: "x.\"odd\"[type".into(),
            direction: EdgeDirection::Backref,
        },
    ];
    for field in &fields {
        for value in &values {
            let expression = condition(field.clone(), FilterOperator::Eq, Some(value.clone()));
            let written = expression.encode().unwrap();
            assert_eq!(
                FilterExpression::decode(&written).unwrap(),
                expression,
                "{written}"
            );
            assert_eq!(
                FilterExpression::decode(&written)
                    .unwrap()
                    .encode()
                    .unwrap(),
                written
            );
        }
    }
}

#[test]
fn reads_one_condition_joined_by_any_as_all_since_the_text_carries_no_join() {
    let mut expression = condition(property("a"), FilterOperator::Exists, None);
    expression.join = FilterJoin::Any;
    let written = expression.encode().unwrap();
    assert_eq!(written, "properties.a exists");
    assert_eq!(
        FilterExpression::decode(&written).unwrap().join,
        FilterJoin::All
    );
}

#[test]
fn writes_any_backslash_escaped_so_a_value_may_end_in_one() {
    for (value, written) in [
        ("\\", "properties.a eq \"\\\\\""),
        ("x\\", "properties.a eq \"x\\\\\""),
        ("x\\\\", "properties.a eq \"x\\\\\\\\\""),
        ("\"\\", "properties.a eq \"\\\"\\\\\""),
    ] {
        let expression = condition(property("a"), FilterOperator::Eq, text(value));
        assert_eq!(expression.encode().unwrap(), written);
        assert_eq!(FilterExpression::decode(written).unwrap(), expression);
    }
}

#[test]
fn refuses_a_number_that_is_not_finite() {
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let (code, _) = refusal(
            condition(
                property("a"),
                FilterOperator::Eq,
                Some(FilterValue::Number(number)),
            )
            .encode(),
        );
        assert_eq!(code, "validation_error");
    }
}

#[test]
fn refuses_a_value_where_the_operator_takes_none_and_none_where_it_takes_one() {
    let (_, message) =
        refusal(condition(property("a"), FilterOperator::Exists, text("x")).encode());
    assert_eq!(message, "Operator \"exists\" takes no value");
    let (_, message) = refusal(condition(property("a"), FilterOperator::Eq, None).encode());
    assert_eq!(message, "Operator \"eq\" takes a value");
}

#[test]
fn refuses_names_the_grammar_would_read_as_something_else() {
    for name in ["", "a.b", "1a", "a-b", "a b", "caf\u{e9}"] {
        let (_, message) =
            refusal(condition(property(name), FilterOperator::Exists, None).encode());
        assert!(
            message.starts_with("Invalid property name"),
            "{name:?}: {message}"
        );
        let member = FilterField::Member {
            field: "emails".into(),
            member: name.into(),
        };
        refusal(condition(member, FilterOperator::Eq, text("x")).encode());
    }
    for edge_type in ["", "a b", "a]b", "a\tb", "a\u{a0}b"] {
        let field = FilterField::Edge {
            edge_type: edge_type.into(),
            direction: EdgeDirection::Outbound,
        };
        let (_, message) = refusal(condition(field, FilterOperator::Exists, None).encode());
        assert!(
            message.starts_with("Invalid edge type"),
            "{edge_type:?}: {message}"
        );
    }
}

#[test]
fn refuses_with_the_servers_message_a_model_the_server_would_refuse() {
    let member = FilterField::Member {
        field: "emails".into(),
        member: "address".into(),
    };
    assert_eq!(
        refusal(condition(member, FilterOperator::Contains, text("x")).encode()).1,
        "Operator \"contains\" is not valid for a member of a list's entries. Use: eq"
    );
    assert_eq!(
        refusal(condition(FilterField::StatusGroup, FilterOperator::Eq, text("done")).encode()).1,
        "Unknown status group \"done\" at position 16. Status groups: not_started, in_progress, completed, canceled"
    );
    let created = FilterField::System {
        name: SystemField::CreatedAt,
    };
    assert_eq!(
        refusal(condition(created, FilterOperator::Gt, Some(FilterValue::Number(5.0))).encode()).1,
        "Invalid created_at: expected a timestamp"
    );
    let empty = FilterExpression {
        join: FilterJoin::All,
        conditions: Vec::new(),
    };
    assert_eq!(
        refusal(empty.encode()).1,
        "Filter expression cannot be empty"
    );
    let eleven = FilterExpression {
        join: FilterJoin::Any,
        conditions: (0..11)
            .map(|_| FilterCondition {
                field: FilterField::Tags,
                operator: FilterOperator::Exists,
                value: None,
            })
            .collect(),
    };
    assert_eq!(
        refusal(eleven.encode()).1,
        "Too many conditions (11). Maximum is 10"
    );
}

#[test]
fn takes_text_of_exactly_2048_utf16_units_and_refuses_one_more_as_the_server_does() {
    // `properties.a eq ""` is 18 units and each emoji 2, so 1,015 emoji make
    // 2,048 units from 1,033 characters.
    let at = |emoji: usize, extra: &str| {
        condition(
            property("a"),
            FilterOperator::Eq,
            text(&format!("{}{extra}", "\u{1F389}".repeat(emoji))),
        )
    };
    let written = at(1015, "").encode().unwrap();
    assert_eq!(written.encode_utf16().count(), 2048);
    assert_eq!(written.chars().count(), 1033);
    assert_eq!(
        refusal(at(1015, "x").encode()),
        (
            "validation_error".to_string(),
            "Filter expression too long (2049 characters). Maximum is 2048".to_string()
        )
    );
    // An escaped quote counts as the two units it is written with.
    let quotes = condition(property("a"), FilterOperator::Eq, text(&"\"".repeat(1015)));
    assert_eq!(quotes.encode().unwrap().encode_utf16().count(), 2048);
    let quotes = condition(property("a"), FilterOperator::Eq, text(&"\"".repeat(1016)));
    assert_eq!(
        refusal(quotes.encode()).1,
        "Filter expression too long (2050 characters). Maximum is 2048"
    );
}

#[test]
fn offers_the_operators_the_grammar_takes_on_each_field() {
    use FilterOperator::*;
    let all = vec![
        Eq, Neq, Gt, Gte, Lt, Lte, Contains, StartsWith, Exists, NotExists,
    ];
    assert_eq!(property("a").operators(), all);
    assert_eq!(
        FilterField::System {
            name: SystemField::CreatedAt
        }
        .operators(),
        all[..8]
    );
    assert_eq!(
        FilterField::Member {
            field: "a".into(),
            member: "b".into()
        }
        .operators(),
        [Eq]
    );
    assert_eq!(FilterField::Tags.operators(), [Contains, Exists, NotExists]);
    assert_eq!(
        FilterField::StatusGroup.operators(),
        [Eq, Neq, Exists, NotExists]
    );
    let edge = FilterField::Edge {
        edge_type: "about".into(),
        direction: EdgeDirection::Backref,
    };
    assert_eq!(edge.operators(), [Eq, Neq, Exists, NotExists]);
    assert!(Eq.takes_value() && !Exists.takes_value() && !NotExists.takes_value());
}

#[test]
fn reads_its_json_form_with_numbers_as_written() {
    let expression: FilterExpression = serde_json::from_value(json!({
        "join": "any",
        "conditions": [
            {"field": {"kind": "property", "name": "rank"}, "operator": "gt", "value": 2},
            {"field": {"kind": "edge", "edge_type": "about", "direction": "outbound"}, "operator": "exists"}
        ]
    }))
    .unwrap();
    assert_eq!(
        expression.encode().unwrap(),
        "properties.rank gt 2 OR edge[about] exists"
    );
}
