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
    Installed,
}

impl Early {
    pub fn code(self) -> &'static str {
        match self {
            Early::NoFields => "missing_required_field",
            Early::InvalidId => "validation_error",
            Early::Reserved(_) | Early::Installed => "forbidden",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Early::NoFields => "fields",
            Early::InvalidId | Early::Reserved(_) | Early::Installed => "id",
        }
    }

    /// The root a refusal names in `details.namespace`.
    pub fn namespace(self) -> Option<&'static str> {
        match self {
            Early::Reserved(root) => Some(root),
            Early::Installed => Some(grammar::COMMON_ROOT),
            Early::NoFields | Early::InvalidId => None,
        }
    }

    pub fn message(self) -> String {
        match self {
            Early::NoFields => "fields is required".into(),
            Early::InvalidId => invalid_id_message(),
            Early::Reserved(root) => format!(
                "Reserved namespace: {root}.* types are platform-shipped and cannot be registered at runtime"
            ),
            Early::Installed => format!(
                "Reserved namespace: {}.* types are shared types, which arrive by installing a plugin (`marfa plugins install`) and cannot be registered directly",
                grammar::COMMON_ROOT
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
    if let Some(root) = grammar::platform_root(id) {
        return Ok(Some(Early::Reserved(root)));
    }
    Ok(grammar::is_common(id).then_some(Early::Installed))
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn refused(id: &str) -> Option<Early> {
        let body = json!({ "id": id, "fields": {} });
        early_refusal(body.as_object().unwrap()).unwrap()
    }

    #[test]
    fn a_new_common_type_is_refused_by_name_and_a_user_type_is_not() {
        for id in ["common.ticket", "common.ticket.spike"] {
            let early = refused(id).unwrap_or_else(|| panic!("{id} was not refused"));
            assert_eq!(early.code(), "forbidden");
            assert_eq!(early.path(), "id");
            assert_eq!(early.namespace(), Some("common"));
            assert!(early.message().contains("marfa plugins install"));
        }
        assert_eq!(refused("user.ticket"), None);
        assert_eq!(refused("common-pub.ticket"), None);
    }

    #[test]
    fn a_platform_root_is_refused_with_its_own_namespace() {
        assert_eq!(refused("core.x").and_then(Early::namespace), Some("core"));
        assert_eq!(refused("marfa.x").and_then(Early::namespace), Some("marfa"));
        assert_eq!(Early::InvalidId.namespace(), None);
    }
}
