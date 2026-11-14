//! The shipped catalog: the types and lists a copy holds before it reaches a server.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::error::RuleError;
use crate::wire::{WireCatalog, WireType};

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

fn list(key: &str) -> Result<Vec<String>, RuleError> {
    static PARSED: OnceLock<Result<HashMap<String, Vec<String>>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            [
                "field_types",
                "entry_member_types",
                "reserved_type_roots",
                "reserved_field_names",
                "searched_field_names",
            ]
            .into_iter()
            .map(|key| {
                serde_json::from_value(document[key].clone())
                    .map(|names| (key.to_string(), names))
                    .map_err(|e| format!("{key}: {e}"))
            })
            .collect()
        })
        .clone()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog's lists: {error}")))
        .and_then(|lists| {
            lists
                .get(key)
                .cloned()
                .ok_or_else(|| RuleError::decoding(format!("the shipped catalog has no {key}")))
        })
}

pub fn field_types() -> Result<Vec<String>, RuleError> {
    list("field_types")
}

pub fn entry_member_types() -> Result<Vec<String>, RuleError> {
    list("entry_member_types")
}

/// The kind each string format turns into; a format absent from it annotates the string and leaves it one.
pub fn format_field_types() -> Result<&'static HashMap<String, String>, RuleError> {
    static PARSED: OnceLock<Result<HashMap<String, String>, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let document: Value = serde_json::from_str(CATALOG).map_err(|e| e.to_string())?;
            serde_json::from_value(document["format_field_types"].clone())
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|error| RuleError::decoding(format!("the shipped catalog's formats: {error}")))
}

pub fn reserved_type_roots() -> Result<Vec<String>, RuleError> {
    list("reserved_type_roots")
}

pub fn reserved_field_names() -> Result<Vec<String>, RuleError> {
    list("reserved_field_names")
}

pub fn searched_field_names() -> Result<Vec<String>, RuleError> {
    list("searched_field_names")
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
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::{Map, Value, json};

    use super::{catalog, shipped_edge_types, shipped_types};
    use crate::catalog::{Catalog, resolve_item_type};
    use crate::schema::{
        Obj, Registry, edge_id, edge_type_from_request, labelled, plural_of, request_shape,
        unread_edge_keys, validate_type,
    };

    /// A definition file's name and what it holds.
    type Source = (String, Obj);

    fn definitions() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/types/core")
    }

    fn read_all(folder: &Path) -> Vec<Source> {
        let mut found: Vec<Source> = fs::read_dir(folder)
            .unwrap_or_else(|e| panic!("{}: {e}", folder.display()))
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .map(|path| {
                let text = fs::read_to_string(&path).unwrap();
                let Value::Object(row) = serde_json::from_str(&text)
                    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
                else {
                    panic!("{} is not an object", path.display())
                };
                (
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    row,
                )
            })
            .collect();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found
    }

    /// Every type definition under `packages/types/core`, and every edge type under `edges/`.
    fn shipped_sources() -> (Vec<Source>, Vec<Source>) {
        let root = definitions();
        let mut folders: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        folders.sort();
        assert_eq!(
            folders,
            ["edges", "system"],
            "a folder of shipped definitions this test does not read"
        );
        let mut types = read_all(&root);
        types.extend(read_all(&root.join("system")));
        (types, read_all(&root.join("edges")))
    }

    fn names_of(value: &Value, known: &BTreeSet<String>, found: &mut BTreeSet<String>) {
        match value {
            Value::String(text) if known.contains(text) => {
                found.insert(text.clone());
            }
            Value::Array(items) => items.iter().for_each(|item| names_of(item, known, found)),
            Value::Object(members) => members
                .values()
                .for_each(|member| names_of(member, known, found)),
            _ => {}
        }
    }

    /// Each type after the shipped types it names: its parent and the types its table columns point at.
    fn in_dependency_order(types: &[Source]) -> Vec<&Obj> {
        let known: BTreeSet<String> = types
            .iter()
            .map(|(_, row)| row["id"].as_str().unwrap().to_string())
            .collect();
        let mut waiting: Vec<(&Obj, BTreeSet<String>)> = types
            .iter()
            .map(|(_, row)| {
                let mut needs = BTreeSet::new();
                names_of(&Value::Object(row.clone()), &known, &mut needs);
                needs.remove(row["id"].as_str().unwrap());
                (row, needs)
            })
            .collect();
        let mut ordered: Vec<&Obj> = Vec::new();
        let mut placed: BTreeSet<&str> = BTreeSet::new();
        while !waiting.is_empty() {
            let (ready, later): (Vec<_>, Vec<_>) = waiting
                .into_iter()
                .partition(|(_, needs)| needs.iter().all(|need| placed.contains(need.as_str())));
            assert!(
                !ready.is_empty(),
                "shipped types depend on one another in a loop"
            );
            for (row, _) in ready {
                placed.insert(row["id"].as_str().unwrap());
                ordered.push(row);
            }
            waiting = later;
        }
        ordered
    }

    #[test]
    fn every_shipped_type_is_one_a_person_could_register() {
        let (sources, _) = shipped_sources();
        let ordered = in_dependency_order(&sources);
        assert_eq!(
            ordered.len(),
            sources.len(),
            "a shipped definition was left out of the order"
        );
        let mut registry = Registry::default();
        let mut refused: Vec<String> = Vec::new();
        let mut accepted = 0;
        for row in ordered {
            let id = row["id"].as_str().unwrap();
            match validate_type(&Value::Object(row.clone()), &registry) {
                Ok(stored) => {
                    accepted += 1;
                    registry = registry.with(labelled(stored));
                }
                Err(issues) => {
                    refused.extend(
                        issues
                            .iter()
                            .map(|issue| format!("{id}: {}: {}", issue.field, issue.message())),
                    );
                    registry = registry.with(row.clone());
                }
            }
        }
        assert!(
            refused.is_empty(),
            "shipped types the server would refuse to register:\n{}",
            refused.join("\n")
        );
        let ships: Vec<&str> = shipped_types()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(accepted, sources.len());
        assert_eq!(
            accepted,
            ships.len(),
            "the shipped catalog and the definition files hold different numbers of types"
        );
        let mut on_disk: Vec<&str> = sources
            .iter()
            .map(|(_, row)| row["id"].as_str().unwrap())
            .collect();
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
        let (_, sources) = shipped_sources();
        let mut refused: Vec<String> = Vec::new();
        for (file, row) in &sources {
            let id = row["id"].as_str().unwrap();
            assert_eq!(file, &format!("{id}.json"), "{file} holds {id}");
            let mut problems: Vec<String> = unread_edge_keys(row)
                .iter()
                .map(|issue| issue.message())
                .collect();
            if let Err(issue) = request_shape(row) {
                problems.push(format!("{issue:?}"));
            }
            if !edge_id(id) {
                problems.push("not an edge type identifier".into());
            }
            if let Err(issue) = edge_type_from_request(row, &|_| None) {
                problems.push(format!("{issue:?}"));
            }
            refused.extend(
                problems
                    .into_iter()
                    .map(|problem| format!("{id}: {problem}")),
            );
        }
        assert!(
            refused.is_empty(),
            "shipped edge types the server would refuse to register:\n{}",
            refused.join("\n")
        );
        let mut on_disk: Vec<&str> = sources
            .iter()
            .map(|(_, row)| row["id"].as_str().unwrap())
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
        let (sources, _) = shipped_sources();
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
