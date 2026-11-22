//! Writes `builtin_catalog.json` and `shipped-shapes.sha256` from the definition files.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    ENTRY_MEMBER_TYPES, FIELD_TYPES, FORMAT_FIELD_TYPES, RESERVED_FIELD_NAMES, RESERVED_TYPE_ROOTS,
    SEARCHED_FIELD_NAMES,
};
use crate::schema::{
    EdgeIssues, Judging, MAX_GUIDANCE_LENGTH, MAX_TYPE_DESCRIPTION_LENGTH, Obj, Registry, edge_id,
    edge_type_from_request, labelled, plural_of, read_guidance_file, request_shape,
    unread_edge_keys, validate_type,
};

/// Edge types where an edge can close a cycle over more than one edge.
const ACYCLIC_EDGE_TYPES: [&str; 2] = ["parent-of", "supersedes"];
/// The edge type whose source must not itself be a valid target.
const FLAT_EDGE_TYPE: &str = "in-collection";

/// Keys a definition carries only for a person reading it. Guidance is prose, so it does not move the shape digest.
const PROSE_KEYS: [&str; 6] = [
    "label",
    "plural",
    "reverse_label",
    "description",
    "id",
    "guidance",
];

/// Keep names such as a field called `description` in a shape digest.
const NAMED_MAPS: [&str; 5] = [
    "fields",
    "property_schema",
    "items_fields",
    "tables",
    "columns",
];

const LARGEST_WHOLE: f64 = 9_007_199_254_740_991.0;

pub(super) type Source = (String, Obj);

pub(super) fn definitions() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("types")
}

pub(super) fn catalog_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/builtin_catalog.json")
}

pub(super) fn digest_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("types/shipped-shapes.sha256")
}

/// Holds each number as JavaScript would read it: a whole number up to 2^53 stays whole, and a larger one is the double JavaScript reads it as.
fn javascript_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let held = number.as_f64().unwrap_or(f64::NAN);
            if held.abs() <= LARGEST_WHOLE {
                if number.is_f64() && held.fract() == 0.0 {
                    // Exactly integral and below 2^53, so the cast loses nothing.
                    *value = Value::from(held as i64);
                }
            } else if !number.is_f64() {
                *value = Value::from(held);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(javascript_numbers),
        Value::Object(members) => members.values_mut().for_each(javascript_numbers),
        _ => {}
    }
}

pub(super) fn read_folder(folder: &Path) -> Result<Vec<Source>, String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .map_err(|e| format!("{}: {e}", folder.display()))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|e| format!("{}: {e}", folder.display()))
        })
        .collect::<Result<_, _>>()?;
    names.retain(|name| Path::new(name).extension().is_some_and(|ext| ext == "json"));
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let path = folder.join(&name);
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let parsed: Value = serde_json::from_str(&text)
                .map_err(|e| format!("{}: not valid JSON: {e}", path.display()))?;
            let Value::Object(mut row) = parsed else {
                return Err(format!("{}: not a JSON object", path.display()));
            };
            if row.contains_key("guidance") {
                return Err(format!(
                    "{}: a shipped definition names `guidance`, which belongs in the Markdown file beside it",
                    path.display()
                ));
            }
            row.values_mut().for_each(javascript_numbers);
            join_guidance(folder, &name, &mut row)?;
            Ok((name, row))
        })
        .collect()
}

/// Item types take guidance from `<name>.md`. System types and edge types have no guidance field.
fn join_guidance(folder: &Path, name: &str, row: &mut Obj) -> Result<(), String> {
    let sibling = format!("{}.md", name.trim_end_matches(".json"));
    let path = folder.join(&sibling);
    if !path.is_file() {
        return Ok(());
    }
    let shown = path.display().to_string();
    let place = folder.file_name().and_then(|folder| folder.to_str());
    if place == Some("system") || place == Some("edges") {
        return Err(format!(
            "{shown}: only a shipped item type carries guidance, so {sibling} must not sit beside {name}"
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("{shown}: {e}"))?;
    let text = read_guidance_file(&bytes).map_err(|fault| fault.message(&shown))?;
    if text.trim().is_empty() {
        return Err(format!("{shown}: guidance is empty"));
    }
    let length = text.chars().count();
    if length > MAX_GUIDANCE_LENGTH {
        return Err(format!(
            "{shown}: guidance: a string of at most {MAX_GUIDANCE_LENGTH} characters (it has {length})"
        ));
    }
    row.insert("guidance".into(), Value::String(text));
    Ok(())
}

pub(super) fn shipped_sources(root: &Path) -> Result<(Vec<Source>, Vec<Source>), String> {
    let mut folders: Vec<String> = fs::read_dir(root)
        .map_err(|e| format!("{}: {e}", root.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    folders.sort();
    if folders != ["edges", "system"] {
        return Err(format!(
            "{} holds folders {folders:?}; the writer reads only edges and system",
            root.display()
        ));
    }
    for folder in ["system", "edges"] {
        let inner: Vec<String> = fs::read_dir(root.join(folder))
            .map_err(|e| format!("{}: {e}", root.join(folder).display()))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .map(|entry| format!("{folder}/{}", entry.file_name().to_string_lossy()))
            .collect();
        if !inner.is_empty() {
            return Err(format!(
                "{} holds folders {inner:?}; the writer reads only the files directly in {folder}",
                root.display()
            ));
        }
    }
    let mut types = read_folder(root)?;
    types.extend(
        read_folder(&root.join("system"))?
            .into_iter()
            .map(|(name, row)| (format!("system/{name}"), row)),
    );
    Ok((types, read_folder(&root.join("edges"))?))
}

fn id_of(file: &str, row: &Obj) -> Result<String, String> {
    row.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("{file}: no `id` that is text"))
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

fn in_dependency_order(types: &[Source]) -> Result<Vec<&Source>, String> {
    let ids: Vec<String> = types
        .iter()
        .map(|(file, row)| id_of(file, row))
        .collect::<Result<_, _>>()?;
    let mut holders: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for ((file, _), id) in types.iter().zip(&ids) {
        holders.entry(id).or_default().push(file);
    }
    if let Some((id, files)) = holders.iter().find(|(_, files)| files.len() > 1) {
        return Err(format!("{} hold the same type id {id}", files.join(", ")));
    }
    let known: BTreeSet<String> = ids.iter().cloned().collect();
    let mut waiting: Vec<(&Source, &str, BTreeSet<String>)> = types
        .iter()
        .zip(&ids)
        .map(|(source, id)| {
            let mut needs = BTreeSet::new();
            names_of(&Value::Object(source.1.clone()), &known, &mut needs);
            needs.remove(id);
            (source, id.as_str(), needs)
        })
        .collect();
    let mut ordered: Vec<&Source> = Vec::new();
    let mut placed: BTreeSet<&str> = BTreeSet::new();
    while !waiting.is_empty() {
        let (ready, later): (Vec<_>, Vec<_>) = waiting
            .into_iter()
            .partition(|(_, _, needs)| needs.iter().all(|need| placed.contains(need.as_str())));
        if ready.is_empty() {
            let stuck: Vec<&str> = later.iter().map(|(_, id, _)| *id).collect();
            return Err(format!(
                "these shipped types depend on one another in a loop, or on one in the loop: {}",
                stuck.join(", ")
            ));
        }
        for (source, id, _) in ready {
            placed.insert(id);
            ordered.push(source);
        }
        waiting = later;
    }
    Ok(ordered)
}

pub(super) struct Registered {
    pub id: String,
    pub stored: Obj,
    pub fields: Obj,
    pub merge_policy: Option<Obj>,
    pub roles: Vec<String>,
}

fn with_required_above(inherited: Option<&Value>, merged: Value) -> Value {
    let above = inherited.and_then(|held| held.get("required")) == Some(&Value::Bool(true));
    match merged {
        Value::Object(mut definition) if above => {
            definition.insert("required".into(), Value::Bool(true));
            Value::Object(definition)
        }
        other => other,
    }
}

pub(super) fn register_types(types: &[Source]) -> Result<Vec<Registered>, Vec<String>> {
    let ordered = in_dependency_order(types).map_err(|e| vec![e])?;
    let mut registry = Registry::default();
    let mut refused: Vec<String> = Vec::new();
    let mut held: HashMap<String, Registered> = HashMap::new();
    let ids: BTreeSet<&str> = types
        .iter()
        .filter_map(|(_, row)| row.get("id").and_then(Value::as_str))
        .collect();
    for (file, row) in ordered {
        let id = id_of(file, row).map_err(|e| vec![e])?;
        if let Some(parent) = row.get("parent").and_then(Value::as_str)
            && !ids.contains(parent)
        {
            refused.push(format!(
                "{file}: {id}: parent: {parent} is not a shipped type"
            ));
            continue;
        }
        let stored =
            match validate_type(&Value::Object(row.clone()), &registry) {
                Ok(stored) => stored,
                Err(issues) => {
                    refused.extend(issues.iter().map(|issue| {
                        format!("{file}: {id}: {}: {}", issue.field, issue.message())
                    }));
                    registry = registry.with(row.clone());
                    continue;
                }
            };
        registry = registry.with(labelled(stored.clone()));
        let parent = stored.get("parent").and_then(Value::as_str);
        let above = parent.and_then(|parent| held.get(parent));
        let mut fields = above.map(|above| above.fields.clone()).unwrap_or_default();
        for (name, own) in stored["fields"].as_object().into_iter().flatten() {
            let inherited = fields.get(name);
            let merged = crate::catalog::merge_field_definition(inherited, own);
            let merged = with_required_above(inherited, merged);
            fields.insert(name.clone(), merged);
        }
        let mut merge_policy = above.and_then(|above| above.merge_policy.clone());
        if let Some(Value::Object(own)) = stored.get("merge_policy") {
            let policy = merge_policy.get_or_insert_with(Obj::new);
            if let Some(Value::Object(members)) = own.get("fields") {
                let slot = policy
                    .entry("fields")
                    .or_insert_with(|| Value::Object(Obj::new()));
                if let Value::Object(slot) = slot {
                    slot.extend(members.clone());
                }
            }
            if let Some(default) = own.get("default").filter(|d| d.as_str() != Some("")) {
                policy.insert("default".into(), default.clone());
            }
        }
        let mut roles: BTreeSet<String> = above
            .map(|above| above.roles.iter().cloned().collect())
            .unwrap_or_default();
        roles.extend(
            stored
                .get("roles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string),
        );
        held.insert(
            id.clone(),
            Registered {
                id,
                stored,
                fields,
                merge_policy,
                roles: roles.into_iter().collect(),
            },
        );
    }
    if !refused.is_empty() {
        return Err(refused);
    }
    Ok(held.into_values().collect())
}

/// A lowercase word, or words joined by single hyphens, that starts with a letter.
fn is_kebab_word(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

pub(super) fn register_edges(edges: &[Source]) -> Result<Vec<Obj>, Vec<String>> {
    let mut refused: Vec<String> = Vec::new();
    let mut found: Vec<Obj> = Vec::new();
    for (file, row) in edges {
        let id = match id_of(file, row) {
            Ok(id) => id,
            Err(e) => {
                refused.push(e);
                continue;
            }
        };
        let mut problems: Vec<String> = unread_edge_keys(row)
            .iter()
            .map(|issue| issue.message())
            .collect();
        if file != &format!("{id}.json") {
            problems.push(format!("the file is named {file}, not {id}.json"));
        }
        if let Err(issue) = request_shape(row) {
            problems.push(format!("{issue:?}"));
        }
        if !edge_id(&id) {
            problems.push("not an edge type identifier".into());
        } else if !is_kebab_word(&id) {
            problems.push("a shipped edge type is one lowercase kebab word".into());
        }
        for key in ["label", "reverse_label"] {
            if !row
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
            {
                problems.push(format!("{key}: a shipped edge type names its {key}"));
            }
        }
        if let Some(reverse) = row.get("reverse_name").and_then(Value::as_str)
            && !is_kebab_word(reverse)
        {
            problems.push(format!(
                "reverse_name: \"{reverse}\" is not one lowercase kebab word"
            ));
        }
        if let Some(text) = row.get("description").and_then(Value::as_str) {
            let length = text.chars().count();
            if length > MAX_TYPE_DESCRIPTION_LENGTH {
                problems.push(format!(
                    "description: a string of at most {MAX_TYPE_DESCRIPTION_LENGTH} characters (it has {length})"
                ));
            }
        }
        for side in ["from_type_constraints", "to_type_constraints"] {
            if row
                .get(side)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                problems.push(format!("{side} is empty. Use [\"*\"] to allow every type."));
            }
        }
        let taken = |name: &str| {
            found.iter().find_map(|edge| {
                let held = edge.get("id").and_then(Value::as_str)?;
                let reverse = edge.get("reverse_name").and_then(Value::as_str);
                (held == name || reverse == Some(name)).then(|| held.to_string())
            })
        };
        match edge_type_from_request(row, &taken, Judging::Register) {
            Ok(stored) => found.push(stored),
            Err(EdgeIssues::Conflict { message, .. }) => problems.push(message),
            Err(issue) => problems.push(format!("{issue:?}")),
        }
        refused.extend(
            problems
                .into_iter()
                .map(|problem| format!("{file}: {id}: {problem}")),
        );
    }
    if refused.is_empty() {
        Ok(found)
    } else {
        Err(refused)
    }
}

fn non_empty<'a>(row: &'a Obj, key: &str) -> Option<&'a Value> {
    row.get(key)
        .filter(|value| value.as_str().is_none_or(|text| !text.is_empty()))
}

/// Merges can leave equivalent fields with different key orders.
fn written_field(field: &Obj) -> Obj {
    let mut out = Obj::new();
    for key in [
        "type",
        "label",
        "description",
        "required",
        "enum_values",
        "status_values",
        "items_type",
        "items_fields",
        "format",
        "searchable",
        "max_length",
        "max_items",
        "minimum",
        "maximum",
    ] {
        if let Some(value) = field.get(key) {
            let kept = match key {
                "required" => value == &Value::Bool(true),
                "searchable" => value == &Value::Bool(false),
                "label" | "description" => non_empty(field, key).is_some(),
                _ => true,
            };
            if kept {
                out.insert(key.into(), value.clone());
            }
        }
    }
    out
}

fn written_fields(fields: &Obj) -> Obj {
    fields
        .iter()
        .filter_map(|(name, field)| {
            Some((
                name.clone(),
                Value::Object(written_field(field.as_object()?)),
            ))
        })
        .collect()
}

fn put(out: &mut Obj, key: &str, value: Value) {
    out.insert(key.into(), value);
}

fn written_type(held: &Registered, tables: Option<&Value>) -> Obj {
    let stored = &held.stored;
    let mut out = Obj::new();
    put(&mut out, "id", Value::String(held.id.clone()));
    for key in ["parent", "label", "plural", "description", "guidance"] {
        if let Some(value) = non_empty(stored, key) {
            put(&mut out, key, value.clone());
        }
    }
    put(
        &mut out,
        "version",
        stored.get("version").cloned().unwrap_or(Value::from(0)),
    );
    put(
        &mut out,
        "fields",
        Value::Object(written_fields(&held.fields)),
    );
    if let Some(tables) = tables {
        put(&mut out, "tables", tables.clone());
    }
    if let Some(Value::Object(hints)) = stored.get("display_hints") {
        let kept: Obj = ["title_field", "body_field", "name_from_body", "icon"]
            .iter()
            .filter_map(|key| {
                let value = hints.get(*key)?;
                (key == &"name_from_body" || non_empty(hints, key).is_some())
                    .then(|| ((*key).to_string(), value.clone()))
            })
            .collect();
        if !kept.is_empty() {
            put(&mut out, "display_hints", Value::Object(kept));
        }
    }
    for key in ["link_field", "version_policy"] {
        if let Some(value) = stored.get(key) {
            put(&mut out, key, value.clone());
        }
    }
    if let Some(policy) = &held.merge_policy {
        let mut kept = Obj::new();
        if let Some(Value::Object(members)) = policy
            .get("fields")
            .filter(|f| f.as_object().is_some_and(|m| !m.is_empty()))
        {
            put(&mut kept, "fields", Value::Object(members.clone()));
        }
        if let Some(default) = policy.get("default") {
            put(&mut kept, "default", default.clone());
        }
        if !kept.is_empty() {
            put(&mut out, "merge_policy", Value::Object(kept));
        }
    }
    if let Some(value) = stored.get("retention_policy") {
        put(&mut out, "retention_policy", value.clone());
    }
    if stored
        .get("roles")
        .and_then(Value::as_array)
        .is_some_and(|roles| !roles.is_empty())
    {
        put(&mut out, "roles", roles_value(&held.roles));
    }
    put(&mut out, "plural", Value::String(plural_of(stored)));
    if !held.roles.is_empty() {
        put(&mut out, "roles", roles_value(&held.roles));
    }
    out
}

fn roles_value(roles: &[String]) -> Value {
    Value::Array(roles.iter().cloned().map(Value::String).collect())
}

fn by_id(a: &Obj, b: &Obj) -> std::cmp::Ordering {
    let id = |row: &Obj| {
        row.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    id(a).cmp(&id(b))
}

fn written_edge(stored: &Obj) -> Obj {
    let mut out = Obj::new();
    for key in [
        "id",
        "label",
        "reverse_label",
        "description",
        "cardinality",
        "from_type_constraints",
        "to_type_constraints",
        "cascade_on_delete",
        "reverse_name",
        "written_from",
    ] {
        if let Some(value) = stored.get(key) {
            put(&mut out, key, value.clone());
        }
    }
    let properties = stored
        .get("property_schema")
        .and_then(Value::as_object)
        .map(written_fields)
        .unwrap_or_default();
    put(&mut out, "property_schema", Value::Object(properties));
    let id = stored.get("id").and_then(Value::as_str).unwrap_or_default();
    put(&mut out, "shipped", Value::Bool(true));
    put(
        &mut out,
        "acyclic",
        Value::Bool(ACYCLIC_EDGE_TYPES.contains(&id)),
    );
    put(&mut out, "flat", Value::Bool(id == FLAT_EDGE_TYPE));
    out
}

/// Match the committed catalog's one-space indentation.
fn pretty(value: &Value) -> String {
    let mut text = crate::number::json_indented(value, " ");
    text.push('\n');
    text
}

/// Keys in UTF-16 code unit order, as JavaScript sorts them.
fn sorted_keys(members: &Obj) -> Vec<&String> {
    let mut keys: Vec<&String> = members.keys().collect();
    keys.sort_by_key(|key| key.encode_utf16().collect::<Vec<u16>>());
    keys
}

fn shape(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(shape).collect()),
        Value::Object(members) => {
            let mut out = Obj::new();
            for key in sorted_keys(members) {
                if PROSE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                let child = &members[key];
                let shaped = match (NAMED_MAPS.contains(&key.as_str()), child) {
                    (true, Value::Object(names)) => Value::Object(
                        sorted_keys(names)
                            .into_iter()
                            .map(|name| (name.clone(), shape(&names[name])))
                            .collect(),
                    ),
                    _ => shape(child),
                };
                out.insert(key.clone(), shaped);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn shapes(definitions: &[Obj]) -> Value {
    let mut ordered: Vec<&Obj> = definitions.iter().collect();
    ordered.sort_by_key(|row| {
        row.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .encode_utf16()
            .collect::<Vec<u16>>()
    });
    Value::Object(
        ordered
            .into_iter()
            .map(|row| {
                let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
                (id.to_string(), shape(&Value::Object(row.clone())))
            })
            .collect(),
    )
}

pub(super) struct Written {
    pub catalog: String,
    pub digest: String,
}

pub(super) fn write(root: &Path) -> Result<Written, Vec<String>> {
    let (type_sources, edge_sources) = shipped_sources(root).map_err(|e| vec![e])?;
    let (types, edges) = match (register_types(&type_sources), register_edges(&edge_sources)) {
        (Ok(types), Ok(edges)) => (types, edges),
        (types, edges) => {
            let mut refused = types.err().unwrap_or_default();
            refused.extend(edges.err().unwrap_or_default());
            return Err(refused);
        }
    };
    let tables: HashMap<String, Value> = type_sources
        .iter()
        .filter_map(|(_, row)| {
            Some((
                row.get("id")?.as_str()?.to_string(),
                row.get("tables")?.clone(),
            ))
        })
        .collect();
    let mut listed: Vec<Obj> = types
        .iter()
        .map(|held| written_type(held, tables.get(&held.id)))
        .collect();
    listed.sort_by(by_id);
    let mut listed_edges: Vec<Obj> = edges.iter().map(written_edge).collect();
    listed_edges.sort_by(by_id);

    let strings = |list: &[&str]| -> Value {
        Value::Array(
            list.iter()
                .map(|name| Value::String((*name).into()))
                .collect(),
        )
    };
    let sorted = |list: &[&str]| -> Value {
        let mut list = list.to_vec();
        list.sort_unstable();
        strings(&list)
    };
    let mut catalog = Obj::new();
    put(
        &mut catalog,
        "types",
        Value::Array(listed.into_iter().map(Value::Object).collect()),
    );
    put(
        &mut catalog,
        "edge_types",
        Value::Array(listed_edges.into_iter().map(Value::Object).collect()),
    );
    put(&mut catalog, "field_types", strings(&FIELD_TYPES));
    put(
        &mut catalog,
        "entry_member_types",
        strings(&ENTRY_MEMBER_TYPES),
    );
    put(
        &mut catalog,
        "format_field_types",
        Value::Object(
            FORMAT_FIELD_TYPES
                .iter()
                .map(|(format, kind)| ((*format).to_string(), Value::String((*kind).into())))
                .collect(),
        ),
    );
    put(
        &mut catalog,
        "reserved_type_roots",
        sorted(&RESERVED_TYPE_ROOTS),
    );
    put(
        &mut catalog,
        "reserved_field_names",
        sorted(&RESERVED_FIELD_NAMES),
    );
    put(
        &mut catalog,
        "searched_field_names",
        sorted(&SEARCHED_FIELD_NAMES),
    );

    let type_shapes: Vec<Obj> = types
        .iter()
        .map(|held| shaped_type(held, tables.get(&held.id)))
        .collect();
    let digest_text = {
        let mut document = Obj::new();
        put(&mut document, "types", shapes(&type_shapes));
        put(&mut document, "edges", shapes(&edges));
        crate::number::json(&Value::Object(document))
    };
    let mut digest = String::new();
    for byte in Sha256::digest(digest_text.as_bytes()) {
        let _ = write!(digest, "{byte:02x}");
    }
    digest.push('\n');
    Ok(Written {
        catalog: pretty(&Value::Object(catalog)),
        digest,
    })
}

fn shaped_type(held: &Registered, tables: Option<&Value>) -> Obj {
    let mut row = held.stored.clone();
    row.insert("fields".into(), Value::Object(held.fields.clone()));
    if let Some(tables) = tables {
        row.insert("tables".into(), tables.clone());
    }
    match &held.merge_policy {
        Some(policy) => row.insert("merge_policy".into(), Value::Object(policy.clone())),
        None => row.remove("merge_policy"),
    };
    row
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const WRITE: &str = "MARFA_WRITE_CATALOG";

    fn agrees(path: &Path, written: &str, how: &str) {
        if std::env::var_os(WRITE).is_some() {
            fs::write(path, written).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            return;
        }
        let committed =
            fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(
            committed == written,
            "{} differs from what the definition files write. {how}",
            path.display()
        );
    }

    struct Copy(PathBuf);

    impl Copy {
        fn new() -> Copy {
            static COPIES: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "marfa-catalog-{}-{}",
                std::process::id(),
                COPIES.fetch_add(1, Ordering::Relaxed)
            ));
            fn copy_into(from: &Path, to: &Path) {
                fs::create_dir_all(to).unwrap();
                for entry in fs::read_dir(from).unwrap() {
                    let entry = entry.unwrap();
                    if entry.path().is_dir() {
                        copy_into(&entry.path(), &to.join(entry.file_name()));
                    } else {
                        fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
                    }
                }
            }
            copy_into(&definitions(), &root);
            Copy(root)
        }

        fn edit(&self, file: &str, change: impl FnOnce(&mut Value)) {
            let path = self.0.join(file);
            let mut row: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            change(&mut row);
            fs::write(&path, row.to_string()).unwrap();
        }

        fn written(&self) -> Written {
            write(&self.0).unwrap_or_else(|e| panic!("{}", e.join("\n")))
        }
    }

    impl Drop for Copy {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_changed_shape_moves_the_digest_and_the_catalog() {
        let shipped = write(&definitions()).unwrap();
        let copy = Copy::new();
        assert_eq!(copy.written().digest, shipped.digest);
        copy.edit("note.json", |row| {
            row["fields"]["body"]["type"] = Value::String("email".into());
        });
        let moved = copy.written();
        assert_ne!(moved.digest, shipped.digest);
        assert_ne!(moved.catalog, shipped.catalog);
    }

    #[test]
    fn a_changed_edge_shape_moves_the_digest() {
        let shipped = write(&definitions()).unwrap();
        let copy = Copy::new();
        copy.edit("edges/about.json", |row| {
            row["cascade_on_delete"] = Value::String("cascade".into());
        });
        assert_ne!(copy.written().digest, shipped.digest);
    }

    #[test]
    fn changed_prose_leaves_the_digest_and_moves_the_catalog() {
        let shipped = write(&definitions()).unwrap();
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["description"] = Value::String("Another way to say it.".into());
            row["label"] = Value::String("Memo".into());
            row["fields"]["body"]["description"] = Value::String("Other words.".into());
        });
        copy.edit("edges/about.json", |row| {
            row["reverse_label"] = Value::String("Other words".into());
        });
        let moved = copy.written();
        assert_eq!(moved.digest, shipped.digest);
        assert_ne!(moved.catalog, shipped.catalog);
    }

    #[test]
    fn a_field_called_description_keeps_its_name_in_the_digest() {
        let shipped = write(&definitions()).unwrap();
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["fields"]["description"]["type"] = Value::String("email".into());
        });
        assert_ne!(copy.written().digest, shipped.digest);
    }

    #[test]
    fn text_in_any_script_is_written_as_it_is() {
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["description"] =
                Value::String("Caf\u{e9} \u{2603} \u{1f4d3} \"quoted\" \\ \t".into());
        });
        let catalog = copy.written().catalog;
        assert!(catalog.contains("\"Caf\u{e9} \u{2603} \u{1f4d3} \\\"quoted\\\" \\\\ \\t\""));
    }

    #[test]
    fn a_file_that_is_not_json_or_not_an_object_is_named() {
        let copy = Copy::new();
        fs::write(copy.0.join("broken.json"), "{ not json").unwrap();
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("broken.json"), "{refused}");
        assert!(refused.contains("not valid JSON"), "{refused}");
        fs::write(copy.0.join("broken.json"), "[1, 2]").unwrap();
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(
            refused.contains("broken.json: not a JSON object"),
            "{refused}"
        );
    }

    #[test]
    fn a_shipped_definition_that_carries_guidance_is_refused_with_its_file() {
        let copy = Copy::new();
        assert!(write(&copy.0).is_ok());
        copy.edit("system/view.json", |row| {
            row["guidance"] = Value::String("Use it.".into());
        });
        copy.edit("note.json", |row| {
            row["guidance"] = Value::String("Use it.".into());
        });
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("note.json"), "{refused}");
        assert!(refused.contains("guidance"), "{refused}");
    }

    #[test]
    fn a_markdown_file_beside_an_item_type_is_its_guidance() {
        let copy = Copy::new();
        fs::write(copy.0.join("note.md"), "Use for a note.\n").unwrap();
        let written = copy.written();
        let catalog: Value = serde_json::from_str(&written.catalog).unwrap();
        let note = catalog["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "core.note")
            .unwrap();
        assert_eq!(note["guidance"], "Use for a note.");
        let bare = Copy::new();
        fs::remove_file(bare.0.join("note.md")).ok();
        assert_eq!(bare.written().digest, written.digest);
        assert_ne!(bare.written().catalog, written.catalog);
        fs::write(copy.0.join("system").join("README.md"), "Notes.").unwrap();
        assert!(write(&copy.0).is_ok());
    }

    #[test]
    fn a_markdown_file_beside_a_system_or_edge_type_is_refused_with_its_file() {
        for (folder, file) in [("system", "view.md"), ("edges", "about.md")] {
            let copy = Copy::new();
            fs::write(copy.0.join(folder).join(file), "Use it.").unwrap();
            let refused = write(&copy.0).err().unwrap().join("\n");
            assert!(refused.contains(file), "{refused}");
            assert!(refused.contains("guidance"), "{refused}");
        }
    }

    #[test]
    fn an_empty_guidance_file_is_refused_with_its_file() {
        for text in ["", " \n\t", "\n"] {
            let copy = Copy::new();
            let path = copy.0.join("note.md");
            fs::write(&path, text).unwrap();
            let refused = write(&copy.0).err().unwrap().join("\n");
            assert!(refused.contains("note.md"), "{refused}");
            assert!(refused.contains("guidance is empty"), "{refused}");
        }
    }

    #[test]
    fn guidance_longer_than_registration_allows_is_refused_with_its_file() {
        let copy = Copy::new();
        let path = copy.0.join("note.md");
        fs::write(&path, "😀".repeat(1_001)).unwrap();
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("note.md"), "{refused}");
        assert!(refused.contains("guidance"), "{refused}");
        assert!(refused.contains("1000"), "{refused}");
        fs::write(&path, "😀".repeat(1_000)).unwrap();
        assert!(write(&copy.0).is_ok());
    }

    #[test]
    fn a_shipped_edge_description_over_200_characters_is_refused_with_its_file() {
        let copy = Copy::new();
        copy.edit("edges/about.json", |row| {
            row["description"] = Value::String(format!("{}😀", "a".repeat(200)));
        });
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("about.json"), "{refused}");
        assert!(refused.contains("description"), "{refused}");
        copy.edit("edges/about.json", |row| {
            row["description"] = Value::String(format!("{}😀", "a".repeat(199)));
        });
        assert!(write(&copy.0).is_ok());
    }

    #[test]
    fn two_files_holding_one_type_id_are_both_named_with_the_id() {
        let copy = Copy::new();
        assert!(write(&copy.0).is_ok());
        fs::copy(copy.0.join("note.json"), copy.0.join("note-copy.json")).unwrap();
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("core.note"), "{refused}");
        assert!(refused.contains("note.json"), "{refused}");
        assert!(refused.contains("note-copy.json"), "{refused}");
    }

    #[test]
    fn a_system_file_holding_a_core_type_id_is_named_with_its_folder() {
        let copy = Copy::new();
        fs::copy(
            copy.0.join("note.json"),
            copy.0.join("system").join("note.json"),
        )
        .unwrap();
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(
            refused.contains("note.json, system/note.json hold the same type id core.note"),
            "{refused}"
        );
    }

    #[test]
    fn a_folder_inside_system_or_edges_is_refused() {
        for folder in ["system", "edges"] {
            let copy = Copy::new();
            assert!(write(&copy.0).is_ok());
            fs::create_dir(copy.0.join(folder).join("extra")).unwrap();
            let refused = write(&copy.0).err().unwrap().join("\n");
            assert!(refused.contains(&format!("{folder}/extra")), "{refused}");
        }
    }

    #[test]
    fn types_that_depend_on_one_another_in_a_loop_are_named() {
        let copy = Copy::new();
        assert!(write(&copy.0).is_ok());
        copy.edit("note.json", |row| {
            row["parent"] = Value::String("core.bookmark".into());
        });
        copy.edit("bookmark.json", |row| {
            row["parent"] = Value::String("core.note".into());
        });
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(refused.contains("loop"), "{refused}");
        assert!(refused.contains("core.note"), "{refused}");
        assert!(refused.contains("core.bookmark"), "{refused}");
    }

    #[test]
    fn a_type_the_server_would_refuse_is_named_with_its_file() {
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["fields"]["body"]["type"] = Value::String("no-such-kind".into());
        });
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(
            refused.contains("note.json: core.note: fields.body"),
            "{refused}"
        );
    }

    #[test]
    fn a_bad_item_type_and_a_bad_edge_type_are_both_named_with_every_fault() {
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["fields"]["body"]["type"] = Value::String("no-such-kind".into());
        });
        copy.edit("edges/about.json", |row| {
            row["cardinality"] = Value::String("sideways".into());
        });
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(
            refused.contains("note.json: core.note: fields.body"),
            "{refused}"
        );
        assert!(refused.contains("about.json: about:"), "{refused}");
    }

    #[test]
    fn a_folder_that_is_missing_is_named() {
        let refused = write(Path::new("/no/such/folder"))
            .err()
            .unwrap()
            .join("\n");
        assert!(refused.contains("/no/such/folder"), "{refused}");
    }

    #[test]
    fn two_new_edges_cannot_share_a_reverse_name() {
        let copy = Copy::new();
        for id in ["made-by-one", "made-by-two"] {
            let edge = serde_json::json!({
                "id": id,
                "label": id,
                "reverse_label": "Made",
                "description": "A test edge.",
                "cardinality": "many-to-many",
                "from_type_constraints": ["*"],
                "to_type_constraints": ["*"],
                "cascade_on_delete": "orphan",
                "reverse_name": "makes",
                "property_schema": {}
            });
            fs::write(copy.0.join(format!("edges/{id}.json")), edge.to_string()).unwrap();
        }
        let refused = write(&copy.0).err().unwrap().join("\n");
        assert!(
            refused.contains(
                "made-by-two.json: made-by-two: \"makes\" is already a name of the edge type made-by-one"
            ),
            "{refused}"
        );
        assert!(!refused.contains("made-by-one.json"), "{refused}");
    }

    #[test]
    fn a_small_number_is_written_as_javascript_writes_it() {
        let copy = Copy::new();
        copy.edit("note.json", |row| {
            row["fields"]["score"] = serde_json::json!({
                "type": "number",
                "minimum": 0.00001,
                "maximum": 1e21
            });
        });
        let catalog = copy.written().catalog;
        assert!(catalog.contains("\"minimum\": 0.00001,"), "{catalog}");
        assert!(catalog.contains("\"maximum\": 1e+21"), "{catalog}");
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        let read = |text: &str| {
            let mut value: Value = serde_json::from_str(text).unwrap();
            javascript_numbers(&mut value);
            (value.clone(), pretty(&value))
        };
        for (text, written) in [
            ("1.0", "1"),
            ("-3.0", "-3"),
            ("1e2", "100"),
            ("0.5", "0.5"),
            ("-0.5", "-0.5"),
            ("0", "0"),
            ("-0.0", "0"),
            ("1e-5", "0.00001"),
            ("1e-6", "0.000001"),
            ("1.5e-7", "1.5e-7"),
            ("-2.5e-9", "-2.5e-9"),
            ("5e-324", "5e-324"),
            ("1e300", "1e+300"),
            ("-1.5e300", "-1.5e+300"),
            ("1e21", "1e+21"),
            ("1e20", "100000000000000000000"),
            ("123456.789", "123456.789"),
            ("9007199254740991", "9007199254740991"),
            ("-9007199254740991", "-9007199254740991"),
            ("9007199254740993", "9007199254740992"),
            ("1152921504606846976", "1152921504606847000"),
            ("18446744073709551615", "18446744073709552000"),
            ("12345678901234567890.5", "12345678901234567000"),
        ] {
            assert_eq!(read(text).1, format!("{written}\n"), "{text}");
        }
        assert_eq!(read("1.0").0, Value::from(1));
        assert_eq!(read("[1, 2.0]").0.to_string(), "[1,2]");
    }

    #[test]
    fn the_committed_catalog_is_what_the_definition_files_write() {
        let written = write(&definitions()).unwrap_or_else(|e| panic!("{}", e.join("\n")));
        agrees(
            &catalog_path(),
            &written.catalog,
            "Run `MARFA_WRITE_CATALOG=1 cargo nextest run -p marfa-rules builtin::catalog_file` and commit it.",
        );
    }

    #[test]
    fn the_committed_digest_is_the_shapes_the_definition_files_hold() {
        let written = write(&definitions()).unwrap_or_else(|e| panic!("{}", e.join("\n")));
        agrees(
            &digest_path(),
            &written.digest,
            "A shipped shape changed. Run `MARFA_WRITE_CATALOG=1 cargo nextest run -p marfa-rules builtin::catalog_file` and commit the digest beside it.",
        );
    }
}
