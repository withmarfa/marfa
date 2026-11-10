//! Rules for registered types and edge types: registration, resolution down a chain, and evolution. A refusal is a list of [`Issue`]s.

mod chain;
mod compat;
mod edge;
mod evolution;
mod field;
mod icons;
mod registry;
mod resolve;
mod tables;
mod type_def;
mod unread;

use serde_json::{Map, Value, json};

pub use chain::{
    MAX_REGISTRATION_CHAIN_DEPTH, broken_compatible_dependents, descendant_depth,
    parent_chain_fault,
};
pub use compat::{ShapeConflict, stored_shape_conflicts};
pub use edge::{
    EdgeIssues, constraint_evolution_changes, edge_id, edge_type_from_request, request_shape,
};
pub use evolution::evolution_of;
pub use field::normalize_field;
pub use icons::{icon_issue, is_icon_id};
pub use registry::Registry;
pub use resolve::{
    ChainFault, MAX_RESOLUTION_DEPTH, canonical, chain, label_or_default, labelled, plural_of,
    read_back_free, resolve, roles_of, with_field_labels,
};
pub use tables::{
    ADDS_UP, ITEM_KIND, MAX_COLUMNS_PER_TABLE, MAX_TABLES_PER_TYPE, ORDER_KINDS, chain_tables,
    declared_tables, normalize_table, order_of, validate_columns, with_set_stored,
    with_table_labels,
};
pub use type_def::validate_type;
pub use unread::{unread_edge_keys, unread_keys};

pub type Obj = Map<String, Value>;

pub const TYPE_ROLES: [&str; 1] = ["container"];
pub const ROLE_PREFIX: &str = "role:";
pub const MAX_LABEL_LENGTH: usize = 100;
pub const MAX_FEED_DAYS: i64 = 36_500;
pub const MERGE_STRATEGIES: [&str; 2] = ["last_writer_wins", "keep_both_copies"];
pub const REFUSED_TYPE_KEYS: [&str; 3] = ["states", "default_state", "transitions"];

/// One fault in a registration, as the wire's `details.errors` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub field: String,
    pub code: Option<&'static str>,
    pub expected: String,
    pub actual: String,
    pub hint: String,
}

impl Issue {
    pub fn new(
        field: impl Into<String>,
        expected: impl Into<String>,
        actual: impl Into<String>,
        hint: impl Into<String>,
    ) -> Issue {
        Issue {
            field: field.into(),
            code: None,
            expected: expected.into(),
            actual: actual.into(),
            hint: hint.into(),
        }
    }

    pub fn coded(mut self, code: &'static str) -> Issue {
        self.code = Some(code);
        self
    }

    pub fn message(&self) -> String {
        format!(
            "Expected {}; received {}. {}",
            self.expected, self.actual, self.hint
        )
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("field".into(), json!(self.field));
        if let Some(code) = self.code {
            out.insert("code".into(), json!(code));
        }
        out.insert("expected".into(), json!(self.expected));
        out.insert("actual".into(), json!(self.actual));
        out.insert("hint".into(), json!(self.hint));
        out.insert("message".into(), json!(self.message()));
        Value::Object(out)
    }
}

pub(crate) fn describe(value: Option<&Value>) -> String {
    match value {
        None => "nothing".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Array(_)) => format!(
            "an array ({})",
            value.map_or(String::new(), Value::to_string)
        ),
        Some(Value::String(text)) => Value::String(text.clone()).to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Object(_)) => "an object".into(),
    }
}

pub(crate) fn as_obj(value: Option<&Value>) -> Option<&Obj> {
    value.and_then(Value::as_object)
}

pub(crate) fn text<'a>(row: &'a Obj, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

pub(crate) fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

pub(crate) fn whole(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

pub(crate) fn positive_integer(value: Option<&Value>) -> bool {
    number(value).is_some_and(|n| whole(n) && n >= 1.0)
}

pub(crate) fn kind(definition: &Obj) -> Option<&str> {
    text(definition, "type")
}

pub(crate) fn required(definition: &Obj) -> bool {
    definition.get("required") == Some(&Value::Bool(true))
}

pub(crate) fn is_role_constraint(entry: &str) -> bool {
    entry.starts_with(ROLE_PREFIX)
}

pub(crate) fn known_role(entry: &str) -> bool {
    entry
        .strip_prefix(ROLE_PREFIX)
        .is_some_and(|name| TYPE_ROLES.contains(&name))
}

pub(crate) fn names(list: &[&str]) -> String {
    list.join(", ")
}
