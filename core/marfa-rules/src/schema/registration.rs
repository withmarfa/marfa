//! Refusal precedence shared by registration and offline checks.

use serde_json::Value;

use super::{Issue, Obj};
use crate::error::RuleError;
use crate::grammar;

/// A body the server refuses before it judges the definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Early {
    NoFields,
    InvalidId,
    Reserved(&'static str),
}

impl Early {
    pub fn code(self) -> &'static str {
        match self {
            Early::NoFields => "missing_required_field",
            Early::InvalidId => "validation_error",
            Early::Reserved(_) => "forbidden",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Early::NoFields => "fields",
            Early::InvalidId | Early::Reserved(_) => "id",
        }
    }

    pub fn message(self) -> String {
        match self {
            Early::NoFields => "fields is required".into(),
            Early::InvalidId => invalid_id_message(),
            Early::Reserved(root) => format!(
                "Reserved namespace: {root}.* types are platform-shipped and cannot be registered at runtime"
            ),
        }
    }
}

pub fn invalid_id_message() -> String {
    format!("Invalid type identifier: {}.", grammar::GRAMMAR)
}

/// The first of these a body breaks, in the order the server asks them.
pub fn early_refusal(body: &Obj) -> Result<Option<Early>, RuleError> {
    if !body.contains_key("fields") {
        return Ok(Some(Early::NoFields));
    }
    let Some(id) = body.get("id").and_then(Value::as_str) else {
        return Ok(None);
    };
    if !grammar::type_id(id)? {
        return Ok(Some(Early::InvalidId));
    }
    Ok(grammar::platform_root(id).map(Early::Reserved))
}

/// What `validate_type`'s faults are answered as: the first of these a fault carries, else `invalid_schema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaVerdict {
    PropertyShadowsField,
    InheritanceViolation,
    InvalidSchema,
}

impl SchemaVerdict {
    pub fn of(issues: &[Issue]) -> SchemaVerdict {
        let has = |code: &str| issues.iter().any(|issue| issue.code == Some(code));
        if has("property_shadows_field") {
            SchemaVerdict::PropertyShadowsField
        } else if has("inheritance_violation") {
            SchemaVerdict::InheritanceViolation
        } else {
            SchemaVerdict::InvalidSchema
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            SchemaVerdict::PropertyShadowsField => "property_shadows_field",
            SchemaVerdict::InheritanceViolation => "inheritance_violation",
            SchemaVerdict::InvalidSchema => "invalid_schema",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            SchemaVerdict::PropertyShadowsField => {
                "Type schema declares a property whose name shadows a first-class Item field"
            }
            SchemaVerdict::InheritanceViolation => {
                "Type gives a field a shape another type in its chain declares differently"
            }
            SchemaVerdict::InvalidSchema => "Invalid type schema",
        }
    }
}
