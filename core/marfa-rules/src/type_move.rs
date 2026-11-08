//! What moving a type's items does to a folder's or view's settings that name the type.

use serde_json::{Map, Value};

use crate::filter::{FilterExpression, FilterField, FilterOperator, FilterValue, SystemField};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Holder {
    Folder,
    View,
}

/// Why a move cannot rewrite a setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    FilterTerm,
    PlacementConflict,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub field: &'static str,
    pub reason: Option<Reason>,
}

/// The fields of one folder or view that name `from`, and its settings as the move leaves them.
#[derive(Clone, Debug, PartialEq)]
pub struct Moved {
    pub named: Vec<Named>,
    pub settings: Map<String, Value>,
}

impl Moved {
    pub fn blocked(&self) -> bool {
        self.named.iter().any(|named| named.reason.is_some())
    }
}

/// `subtypes` keeps `from` beside `to` in `query.types`, since a query naming a parent reaches its
/// subtypes' items, which stay where they are.
pub fn settings(
    holder: Holder,
    settings: &Map<String, Value>,
    from: &str,
    to: &str,
    subtypes: bool,
) -> Moved {
    let mut moved = Moved {
        named: Vec::new(),
        settings: settings.clone(),
    };
    if let Some(Value::Object(query)) = moved.settings.get_mut("query") {
        if let Some(Value::Array(types)) = query.get_mut("types")
            && types.iter().any(|entry| entry.as_str() == Some(from))
        {
            moved.named.push(Named {
                field: "query.types",
                reason: None,
            });
            *types = retyped_list(types, from, to, subtypes);
        }
        if let Some(Value::String(text)) = query.get_mut("filter") {
            match retyped_filter(text, from, to) {
                Filter::Unnamed => {}
                Filter::Rewritten(rewritten) => {
                    moved.named.push(Named {
                        field: "query.filter",
                        reason: None,
                    });
                    *text = rewritten;
                }
                Filter::Blocked => moved.named.push(Named {
                    field: "query.filter",
                    reason: Some(Reason::FilterTerm),
                }),
            }
        }
    }
    if holder == Holder::View {
        return moved;
    }
    if let Some(Value::Object(defaults)) = moved.settings.get_mut("defaults")
        && defaults.get("type").and_then(Value::as_str) == Some(from)
    {
        moved.named.push(Named {
            field: "defaults.type",
            reason: None,
        });
        defaults.insert("type".into(), Value::from(to));
    }
    if let Some(Value::Object(placement)) = moved.settings.get_mut("first_placement")
        && let Some(directory) = placement.get(from).cloned()
    {
        let apart = placement.get(to).is_some_and(|held| *held != directory);
        moved.named.push(Named {
            field: "first_placement",
            reason: apart.then_some(Reason::PlacementConflict),
        });
        placement.remove(from);
        placement.entry(to.to_string()).or_insert(directory);
    }
    moved
}

/// The fields that name `type_id` as a move would rewrite them.
pub fn names(holder: Holder, settings: &Map<String, Value>, type_id: &str) -> Vec<&'static str> {
    let mut named = Vec::new();
    let query = settings.get("query").and_then(Value::as_object);
    if query
        .and_then(|query| query.get("types"))
        .and_then(Value::as_array)
        .is_some_and(|types| types.iter().any(|entry| entry.as_str() == Some(type_id)))
    {
        named.push("query.types");
    }
    let filter = query
        .and_then(|query| query.get("filter"))
        .and_then(Value::as_str)
        .and_then(|text| FilterExpression::decode(text).ok());
    if filter.is_some_and(|expression| {
        expression.conditions.iter().any(|condition| {
            condition.field == (FilterField::System { name: SystemField::Type })
                && matches!(condition.operator, FilterOperator::Eq | FilterOperator::Neq)
                && condition.value == Some(FilterValue::Text(type_id.to_string()))
        })
    }) {
        named.push("query.filter");
    }
    if holder == Holder::Folder {
        if settings
            .get("defaults")
            .and_then(|defaults| defaults.get("type"))
            .and_then(Value::as_str)
            == Some(type_id)
        {
            named.push("defaults.type");
        }
        if settings
            .get("first_placement")
            .and_then(Value::as_object)
            .is_some_and(|placement| placement.contains_key(type_id))
        {
            named.push("first_placement");
        }
    }
    named
}

fn retyped_list(types: &[Value], from: &str, to: &str, subtypes: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(types.len() + 1);
    let mut keep = |entry: Value| {
        if !out.contains(&entry) {
            out.push(entry);
        }
    };
    for entry in types {
        if entry.as_str() == Some(from) {
            if subtypes {
                keep(entry.clone());
            }
            keep(Value::from(to));
        } else {
            keep(entry.clone());
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum Filter {
    Unnamed,
    Rewritten(String),
    Blocked,
}

/// A `type eq` or `type neq` naming `from` names `to` instead. Any other term on `type` whose
/// answer differs for the two blocks the move, as does a rewrite longer than a filter may be.
fn retyped_filter(text: &str, from: &str, to: &str) -> Filter {
    let Ok(mut expression) = FilterExpression::decode(text) else {
        return Filter::Unnamed;
    };
    let mut rewritten = false;
    for condition in &mut expression.conditions {
        if condition.field != (FilterField::System { name: SystemField::Type }) {
            continue;
        }
        let named = matches!(condition.operator, FilterOperator::Eq | FilterOperator::Neq)
            && condition.value == Some(FilterValue::Text(from.to_string()));
        if named {
            condition.value = Some(FilterValue::Text(to.to_string()));
            rewritten = true;
        } else if answer(condition.operator, condition.value.as_ref(), from)
            != answer(condition.operator, condition.value.as_ref(), to)
        {
            return Filter::Blocked;
        }
    }
    if !rewritten {
        return Filter::Unnamed;
    }
    expression
        .encode()
        .map_or(Filter::Blocked, Filter::Rewritten)
}

/// `contains` and `starts_with` compare ASCII letters in either case, as the listing does.
fn answer(operator: FilterOperator, value: Option<&FilterValue>, type_id: &str) -> bool {
    let Some(FilterValue::Text(value)) = value else {
        return !matches!(operator, FilterOperator::NotExists);
    };
    let folded = |text: &str| text.to_ascii_lowercase();
    match operator {
        FilterOperator::Eq => type_id == value,
        FilterOperator::Neq => type_id != value,
        FilterOperator::Gt => type_id > value.as_str(),
        FilterOperator::Gte => type_id >= value.as_str(),
        FilterOperator::Lt => type_id < value.as_str(),
        FilterOperator::Lte => type_id <= value.as_str(),
        FilterOperator::Contains => folded(type_id).contains(&folded(value)),
        FilterOperator::StartsWith => folded(type_id).starts_with(&folded(value)),
        FilterOperator::Exists => true,
        FilterOperator::NotExists => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn moved(holder: Holder, settings: Value, subtypes: bool) -> Moved {
        let Value::Object(settings) = settings else {
            panic!("settings are an object");
        };
        super::settings(holder, &settings, "a.deal", "a.contract", subtypes)
    }

    #[test]
    fn rewrites_each_field_that_names_the_type() {
        let done = moved(
            Holder::Folder,
            json!({
                "query": {
                    "types": ["a.deal", "core.note"],
                    "filter": "type eq \"a.deal\" OR properties.name eq \"a.deal\"",
                },
                "defaults": { "type": "a.deal", "tags": ["kept"] },
                "first_placement": { "a.deal": "Deals", "core.note": "Notes" },
            }),
            false,
        );
        assert!(!done.blocked());
        assert_eq!(
            done.named.iter().map(|named| named.field).collect::<Vec<_>>(),
            ["query.types", "query.filter", "defaults.type", "first_placement"]
        );
        assert_eq!(
            Value::Object(done.settings),
            json!({
                "query": {
                    "types": ["a.contract", "core.note"],
                    "filter": "type eq \"a.contract\" OR properties.name eq \"a.deal\"",
                },
                "defaults": { "type": "a.contract", "tags": ["kept"] },
                "first_placement": { "core.note": "Notes", "a.contract": "Deals" },
            })
        );
    }

    #[test]
    fn keeps_a_parent_beside_its_new_type_and_names_each_once() {
        let kept = moved(Holder::View, json!({ "query": { "types": ["a.deal"] } }), true);
        assert_eq!(kept.settings["query"]["types"], json!(["a.deal", "a.contract"]));
        let merged = moved(
            Holder::View,
            json!({ "query": { "types": ["a.contract", "a.deal"] } }),
            false,
        );
        assert_eq!(merged.settings["query"]["types"], json!(["a.contract"]));
    }

    #[test]
    fn blocks_a_term_whose_answer_moves_and_leaves_one_that_does_not() {
        let starts = moved(
            Holder::View,
            json!({ "query": { "filter": "type starts_with \"a.d\"" } }),
            false,
        );
        assert_eq!(starts.named[0].reason, Some(Reason::FilterTerm));
        let other = moved(
            Holder::View,
            json!({ "query": { "filter": "type starts_with \"core.\"" } }),
            false,
        );
        assert!(other.named.is_empty());
    }

    #[test]
    fn blocks_a_rewrite_longer_than_a_filter_may_be() {
        let head = "type eq \"a.deal\" OR properties.name eq \"";
        let text = format!("{head}{}\"", "x".repeat(2048 - head.len() - 1));
        let long = moved(Holder::View, json!({ "query": { "filter": text } }), false);
        assert_eq!(long.named[0].reason, Some(Reason::FilterTerm));
    }

    #[test]
    fn blocks_a_placement_that_puts_the_types_apart() {
        let apart = moved(
            Holder::Folder,
            json!({ "first_placement": { "a.deal": "Deals", "a.contract": "Contracts" } }),
            false,
        );
        assert_eq!(apart.named[0].reason, Some(Reason::PlacementConflict));
        let together = moved(
            Holder::Folder,
            json!({ "first_placement": { "a.deal": "Deals", "a.contract": "Deals" } }),
            false,
        );
        assert!(!together.blocked());
        assert_eq!(together.settings["first_placement"], json!({ "a.contract": "Deals" }));
    }
}
