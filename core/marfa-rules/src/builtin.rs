//! The shipped catalog: the types and lists a copy holds before it reaches a server.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::error::RuleError;
use crate::wire::{WireCatalog, WireType};

#[cfg(test)]
mod catalog_file;
#[cfg(test)]
mod registration_cases;

const CATALOG: &str = include_str!("builtin_catalog.json");

pub fn catalog() -> Result<WireCatalog, RuleError> {
    static PARSED: OnceLock<Result<WireCatalog, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            let edge_types = match document["edge_types"].take() {
                Value::Array(rows) => rows,
                _ => return Err("the shipped catalog has no edge types".into()),
            };
            let types: Vec<WireType> =
                serde_json::from_value(document["types"].take()).map_err(|e| e.to_string())?;
            Ok(WireCatalog { types, edge_types })
        })
        .clone()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

/// The kinds a field may take.
pub const FIELD_TYPES: [&str; 13] = [
    "string",
    "number",
    "integer",
    "boolean",
    "url",
    "email",
    "datetime",
    "date",
    "enum",
    "array",
    "object",
    "thumbnail",
    "status",
];

/// The kinds a member of a list's entries may take: plain values, so an entry stays one flat object.
pub const ENTRY_MEMBER_TYPES: [&str; 9] = [
    "string", "email", "url", "enum", "boolean", "integer", "number", "date", "datetime",
];

/// The formats that have a kind of their own, with that kind. The others annotate a string and leave it one.
pub const FORMAT_FIELD_TYPES: [(&str, &str); 4] = [
    ("url", "url"),
    ("email", "email"),
    ("date", "date"),
    ("thumbnail", "thumbnail"),
];

/// The first segments no publisher may take: the six namespaces Marfa holds, the root of each permission and scope family, and the one word the glossary bans.
pub const RESERVED_TYPE_ROOTS: [&str; 23] = [
    "core",
    "system",
    "app",
    "user",
    "marfa",
    "common",
    "schema",
    "keys",
    "items",
    "webhooks",
    "config",
    "audit",
    "grants",
    "instance",
    "connectors",
    "blobs",
    "backups",
    "sign_ins",
    "content",
    "metadata",
    "edge",
    "profile",
    "space",
];

/// The first-class names of an item, which no field may take: a row would carry two values under one key.
pub const RESERVED_FIELD_NAMES: [&str; 19] = [
    "id",
    "type",
    "state",
    "tier",
    "properties",
    "created_at",
    "updated_at",
    "occurred_at",
    "source",
    "source_id",
    "version",
    "schema_version",
    "capture_latitude",
    "capture_longitude",
    "trashed_at",
    "trashed_by_cascade",
    "trashed_with",
    "last_activity_at",
    "read_only",
];

/// The names full-text search indexes whatever their kind, so a thumbnail may not take one.
pub const SEARCHED_FIELD_NAMES: [&str; 4] = ["title", "body", "description", "name"];

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_string()).collect()
}

pub fn field_types() -> Result<Vec<String>, RuleError> {
    Ok(names(&FIELD_TYPES))
}

pub fn entry_member_types() -> Result<Vec<String>, RuleError> {
    Ok(names(&ENTRY_MEMBER_TYPES))
}

/// The kind each string format turns into; a format absent from it annotates the string and leaves it one.
pub fn format_field_types() -> Result<&'static HashMap<String, String>, RuleError> {
    static FORMATS: OnceLock<HashMap<String, String>> = OnceLock::new();
    Ok(FORMATS.get_or_init(|| {
        FORMAT_FIELD_TYPES
            .iter()
            .map(|(format, kind)| ((*format).to_string(), (*kind).to_string()))
            .collect()
    }))
}

pub fn reserved_type_roots() -> Result<Vec<String>, RuleError> {
    Ok(names(&RESERVED_TYPE_ROOTS))
}

pub fn reserved_field_names() -> Result<Vec<String>, RuleError> {
    Ok(names(&RESERVED_FIELD_NAMES))
}

pub fn searched_field_names() -> Result<Vec<String>, RuleError> {
    Ok(names(&SEARCHED_FIELD_NAMES))
}

/// Asked of every row an export checks, so it reads the parsed list, which is sorted by id.
pub fn ships(id: &str) -> Result<bool, RuleError> {
    Ok(shipped_types()?
        .binary_search_by(|shipped| shipped.get("id").and_then(Value::as_str).cmp(&Some(id)))
        .is_ok())
}

pub fn shipped_types() -> Result<&'static [Map<String, Value>], RuleError> {
    static PARSED: OnceLock<Result<Vec<Map<String, Value>>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            let mut types: Vec<Map<String, Value>> =
                serde_json::from_value(document["types"].take()).map_err(|e| e.to_string())?;
            types.sort_by(|a, b| {
                a.get("id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("id").and_then(Value::as_str))
            });
            Ok(types)
        })
        .as_ref()
        .map(Vec::as_slice)
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

pub fn shipped_edge_types() -> Result<&'static [Value], RuleError> {
    static PARSED: OnceLock<Result<Vec<Value>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let mut document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            match document["edge_types"].take() {
                Value::Array(rows) => Ok(rows),
                _ => Err("the shipped catalog has no edge types".into()),
            }
        })
        .as_ref()
        .map(Vec::as_slice)
        .map_err(|error| RuleError::decoding(format!("the shipped catalog: {error}")))
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use serde_json::{Map, Value, json};

    use super::{catalog, shipped_edge_types, shipped_types};
    use crate::catalog::{Catalog, resolve_item_type};
    use crate::schema::{Obj, Registry, plural_of, validate_type};

    use super::catalog_file::{
        Source, definitions, register_edges, register_types, shipped_sources,
    };

    fn sources() -> (Vec<Source>, Vec<Source>) {
        shipped_sources(&definitions()).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn every_shipped_type_is_one_a_person_could_register() {
        let (sources, _) = sources();
        let registered =
            register_types(&sources).unwrap_or_else(|refused| panic!("{}", refused.join("\n")));
        let ships: Vec<&str> = shipped_types()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            registered.len(),
            ships.len(),
            "the shipped catalog and the definition files hold different numbers of types"
        );
        let mut on_disk: Vec<&str> = registered.iter().map(|held| held.id.as_str()).collect();
        on_disk.sort_unstable();
        assert_eq!(on_disk, ships);
    }

    #[test]
    fn the_registered_type_rules_refuse_a_type_that_breaks_one() {
        let valid = json!({
            "id": "core.example",
            "fields": {"title": {"type": "string", "description": "A name."}}
        });
        let mut broken = valid.clone();
        broken["fields"]["title"]["type"] = json!("no-such-kind");
        assert!(validate_type(&valid, &Registry::default()).is_ok());
        let issues = validate_type(&broken, &Registry::default()).unwrap_err();
        assert!(
            issues
                .iter()
                .any(|issue| issue.field.starts_with("fields.title"))
        );
    }

    #[test]
    fn every_shipped_edge_type_is_one_a_person_could_register() {
        let (_, sources) = sources();
        let registered =
            register_edges(&sources).unwrap_or_else(|refused| panic!("{}", refused.join("\n")));
        let mut on_disk: Vec<&str> = registered
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        on_disk.sort_unstable();
        let mut shipped: Vec<&str> = shipped_edge_types()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        shipped.sort_unstable();
        assert_eq!(on_disk, shipped);
        assert!(!on_disk.is_empty());
    }

    #[test]
    fn every_shipped_type_is_given_the_plural_a_registered_type_is_given() {
        let (sources, _) = sources();
        let held: HashMap<String, Obj> = sources
            .iter()
            .map(|(_, row)| (row["id"].as_str().unwrap().to_string(), row.clone()))
            .collect();
        let registry = Registry::new(held.values().cloned());
        let shipped = catalog().unwrap();
        let mut disagreements: Vec<String> = Vec::new();
        for (_, row) in &sources {
            let id = row["id"].as_str().unwrap();
            let resolved = crate::schema::resolve(&registry, id, false)
                .unwrap()
                .unwrap();
            let item = resolve_item_type(id, &held, &Catalog::empty())
                .unwrap()
                .unwrap();
            let in_catalog = shipped
                .types
                .iter()
                .find(|t| t.id == id)
                .and_then(|t| t.rest.get("plural"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let answers = [
                ("plural_of", plural_of(row)),
                ("resolve", resolved["plural"].as_str().unwrap().to_string()),
                ("resolve_item_type", item.plural),
                ("builtin_catalog.json", in_catalog.to_string()),
            ];
            if answers.iter().any(|(_, plural)| *plural != answers[0].1) {
                disagreements.push(format!("{id}: {answers:?}"));
            }
        }
        assert!(
            disagreements.is_empty(),
            "the plural of a shipped type differs by the rule that makes it:\n{}",
            disagreements.join("\n")
        );
        assert!(
            sources.iter().any(|(_, row)| !row.contains_key("plural")),
            "no shipped type leaves its plural to the rule"
        );
    }

    #[test]
    fn every_table_a_shipped_type_declares_is_judged_as_a_registered_type_declares_it() {
        let rows: Vec<Value> = shipped_types()
            .unwrap()
            .iter()
            .cloned()
            .map(Value::Object)
            .collect();
        let known: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        let judged = crate::schema::declared_tables(&rows, &|id| known.contains(&id))
            .unwrap_or_else(|issues| panic!("a shipped table is refused: {issues:?}"));
        let conversation = judged
            .iter()
            .find(|(id, _)| id == "core.conversation")
            .map(|(_, tables)| tables)
            .unwrap();
        let columns: Vec<&String> = conversation["messages"]["columns"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(columns, ["author", "text", "sent_at", "attachment"]);
    }

    #[test]
    fn the_shipped_game_and_rating_are_judged_as_the_server_judges_them() {
        let shipped = catalog().unwrap();
        let game = shipped
            .types
            .iter()
            .find(|t| t.id == "core.media.game")
            .unwrap();
        let fields: BTreeMap<&str, &Value> = game.rest["fields"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, definition)| (name.as_str(), definition))
            .collect();
        let judged = |properties: Value| {
            let Value::Object(properties): Value = properties else {
                unreachable!()
            };
            crate::validation::properties(&fields, &properties, true)
                .err()
                .map(|e| e.to_string())
        };
        let title = |extra: Value| {
            let mut properties = Map::from_iter([("title".to_string(), json!("A game"))]);
            properties.extend(extra.as_object().unwrap().clone());
            Value::Object(properties)
        };
        assert_eq!(
            judged(title(
                json!({"platforms": ["PC", "Tabletop"], "min_players": 1, "max_players": 4, "rating": 5})
            )),
            None
        );
        for bad in [
            json!({"rating": 0}),
            json!({"rating": 6}),
            json!({"rating": 3.5}),
            json!({"min_players": 0}),
            json!({"max_players": -1}),
            json!({"platforms": ["PC", 1]}),
        ] {
            let name = bad.as_object().unwrap().keys().next().unwrap().clone();
            let refusal = judged(title(bad.clone()));
            assert!(
                refusal.is_some_and(|message| message.contains(&name)),
                "{bad}"
            );
        }
    }
}
