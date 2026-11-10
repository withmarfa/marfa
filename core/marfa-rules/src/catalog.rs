//! The type catalog as a value: what types declare and inherit, how properties are judged against it and how an item is shown by it.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::display::ItemDisplay;
use crate::error::{Code, FieldError, RuleError, field_code};
use crate::schema::{OWN_COLUMNS, OWN_TABLE_TYPE, judge_item_columns};
use crate::wire::{WireEdgeType, WireType, label_from_id, label_from_name, plural_from_label};

const TITLE_PROPERTY: &str = "title";

/// Optional fields every type takes, though no read of a type lists them, with each element's type.
const EVERY_TYPE_TAKES: [(&str, &str); 2] = [("attachments", "object"), ("links", "string")];
const BODY_PROPERTY: &str = "body";

#[derive(Debug)]
pub struct CatalogEntry {
    pub parent: Option<String>,
    pub title_field: Option<String>,
    pub thumbnail_field: Option<String>,
    pub body_field: Option<String>,
    pub name_from_body: Option<bool>,
    pub icon: Option<String>,
    pub fields: Vec<String>,
    pub definitions: Map<String, Value>,
}

impl CatalogEntry {
    pub fn from_wire(held: &WireType) -> CatalogEntry {
        let hints = held.display_hints.clone().unwrap_or_default();
        let definitions = held
            .rest
            .get("fields")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        CatalogEntry {
            parent: held.parent.clone(),
            title_field: hints.title_field,
            thumbnail_field: thumbnail_field_of(&held.rest),
            body_field: hints.body_field,
            name_from_body: hints.name_from_body,
            icon: hints.icon,
            fields: definitions.keys().cloned().collect(),
            definitions,
        }
    }
}

pub fn thumbnail_field_of(declared: &Map<String, Value>) -> Option<String> {
    declared
        .get("fields")?
        .as_object()?
        .iter()
        .find(|(_, field)| field.get("type").and_then(Value::as_str) == Some("thumbnail"))
        .map(|(name, _)| name.clone())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum End {
    Source,
    Target,
}

/// Which end of an edge has the file that writes it in a folder, or neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WrittenAt {
    Source,
    Target,
    /// No file writes the edge, and a folder never renders it.
    None,
}

impl WrittenAt {
    pub fn end(self) -> Option<End> {
        match self {
            WrittenAt::Source => Some(End::Source),
            WrittenAt::Target => Some(End::Target),
            WrittenAt::None => None,
        }
    }
}

impl From<End> for WrittenAt {
    fn from(end: End) -> WrittenAt {
        match end {
            End::Source => WrittenAt::Source,
            End::Target => WrittenAt::Target,
        }
    }
}

impl End {
    pub fn other(self) -> End {
        match self {
            End::Source => End::Target,
            End::Target => End::Source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypeField {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub required: bool,
    /// The nearest label the chain names, else the one its name makes. An edge type's property names none.
    pub label: String,
    pub description: Option<String>,
    /// The nearest type in the chain that declares it.
    pub declared_by: String,
    pub definition: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemType {
    pub id: String,
    pub label: Option<String>,
    /// Its own plural, else the one its label makes. Never inherited.
    pub plural: String,
    pub description: Option<String>,
    pub parent: Option<String>,
    pub version: i64,
    pub fields: Vec<TypeField>,
    /// Each table the type declares or inherits, by name, with the labels a read of it gives.
    pub tables: Map<String, Value>,
    pub title_field: Option<String>,
    pub body_field: Option<String>,
    /// False where an item's body does not name it, such as a highlight's passage.
    pub name_from_body: bool,
    /// Iconify icon ID `<set>:<name>`: the owner's choice where made, else the nearest author's.
    pub icon: Option<String>,
    pub link_field: Option<String>,
    pub roles: Vec<String>,
    pub compatible_with: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EdgeType {
    pub id: String,
    pub label: String,
    /// Same as `label` where the relation is two-way.
    pub reverse_label: String,
    pub description: Option<String>,
    pub cardinality: String,
    pub reverse_name: Option<String>,
    pub written_at: WrittenAt,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    pub properties: Vec<TypeField>,
    pub shipped: bool,
    /// Whether an edge of this type that closes a cycle through edges of the type is refused.
    pub acyclic: bool,
    /// Whether a source its own target constraints admit is refused.
    pub flat: bool,
}

impl EdgeType {
    /// The name a file at `end` writes an edge of this type under, if any.
    pub fn name_at(&self, end: End) -> Option<&str> {
        if self.written_at == WrittenAt::None {
            return None;
        }
        match end {
            End::Source => Some(&self.id),
            End::Target => self.reverse_name.as_deref(),
        }
    }

    pub fn one_at(&self, end: End) -> bool {
        matches!(
            (end, self.cardinality.as_str()),
            (End::Source, "one-to-one" | "many-to-one")
                | (End::Target, "one-to-one" | "one-to-many")
        )
    }
}

impl EdgeType {
    pub fn from_wire(wire: WireEdgeType) -> Result<EdgeType, RuleError> {
        let properties = wire
            .property_schema
            .iter()
            .map(|(name, definition)| field(name, definition, &wire.id))
            .collect::<Result<_, _>>()?;
        Ok(EdgeType {
            label: wire.label(),
            reverse_label: wire.reverse_label(),
            id: wire.id,
            description: wire.description,
            cardinality: wire.cardinality,
            reverse_name: wire.reverse_name,
            written_at: wire.written_at,
            source_type_constraints: wire.source_type_constraints,
            target_type_constraints: wire.target_type_constraints,
            cascade_on_delete: wire.cascade_on_delete,
            properties,
            shipped: wire.shipped,
            acyclic: wire.acyclic,
            flat: wire.flat,
        })
    }
}

const SHIPPED_ROOTS: [&str; 3] = ["core", "system", "marfa"];

/// An object naming an identifier outside Marfa's, whose fields each have a type and whose parent this copy knows. Answers its id and the JSON it is kept as, with what a registration requires filled in.
pub fn declaration(
    definition: &Value,
    known: &dyn Fn(&str) -> bool,
) -> Result<(String, String), RuleError> {
    let invalid = |message: String| RuleError::invalid(message);
    let Some(row) = definition.as_object() else {
        return Err(invalid(
            "a type to declare is an object naming its id and its fields".into(),
        ));
    };
    let Some(id) = row.get("id").and_then(Value::as_str) else {
        return Err(invalid("a type to declare names its id".into()));
    };
    let root = id.split('.').next().unwrap_or_default();
    if !crate::grammar::type_id(id)? {
        return Err(invalid(format!(
            "not a type to declare: {id:?}; {}",
            crate::grammar::GRAMMAR
        )));
    }
    if SHIPPED_ROOTS.contains(&root) || crate::builtin::ships(id)? {
        return Err(invalid(format!(
            "{id} is Marfa's, and an app declares types under its own namespace: `app.`, `user.` or a name of its own"
        )));
    }
    let mut row = row.clone();
    match row.get("fields") {
        None => {
            row.insert("fields".into(), Value::Object(Map::new()));
        }
        Some(Value::Object(_)) => {
            let folded = normalized_type(definition)?;
            let fields = folded["fields"].as_object().into_iter().flatten();
            let kinds = crate::builtin::field_types()?;
            for (name, definition) in fields.clone() {
                let held =
                    field(name, definition, id).map_err(|error| invalid(error.to_string()))?;
                if !kinds.contains(&held.r#type) {
                    return Err(invalid(format!(
                        "{id} declares {name} as {:?}, which is not a field type: one of {}",
                        held.r#type,
                        kinds.join(", ")
                    )));
                }
                if let Some(problem) = status_declaration(&held.r#type, definition) {
                    return Err(invalid(format!("{id} declares {name} {problem}")));
                }
                if let Some(problem) = entries_declaration(&held.r#type, definition)? {
                    return Err(invalid(format!("{id} declares {name} {problem}")));
                }
            }
            let statuses = fields
                .filter(|(_, definition)| {
                    definition.get("type").and_then(Value::as_str) == Some("status")
                })
                .count();
            if statuses > 1 {
                return Err(invalid(format!(
                    "{id} declares {statuses} status fields, and a type has at most one"
                )));
            }
        }
        Some(_) => return Err(invalid(format!("the fields of {id} are an object by name"))),
    }
    if !row.contains_key("version") {
        row.insert("version".into(), Value::from(0));
    }
    if let Some(parent) = row.get("parent").and_then(Value::as_str)
        && parent != id
        && !known(parent)
    {
        return Err(invalid(format!(
            "{id} names the parent {parent}, which is neither a type Marfa ships nor one declared"
        )));
    }
    Ok((id.to_string(), Value::Object(row).to_string()))
}

/// Refuses a declared type whose `status` field has no words anywhere in its chain, the declared set's and the shipped types'.
pub fn refuse_wordless_status(types: &[Value]) -> Result<(), RuleError> {
    let shipped = crate::builtin::catalog()?;
    type Link<'a> = (Option<&'a str>, Option<&'a Map<String, Value>>);
    let mut chain: HashMap<&str, Link> = shipped
        .types
        .iter()
        .map(|held| {
            (
                held.id.as_str(),
                (
                    held.parent.as_deref(),
                    held.rest.get("fields").and_then(Value::as_object),
                ),
            )
        })
        .collect();
    for definition in types {
        if let Some(id) = definition.get("id").and_then(Value::as_str) {
            chain.insert(
                id,
                (
                    definition.get("parent").and_then(Value::as_str),
                    definition.get("fields").and_then(Value::as_object),
                ),
            );
        }
    }
    let has_words = |definition: &Value| {
        definition.get("type").and_then(Value::as_str) == Some("status")
            && definition
                .get("status_values")
                .and_then(Value::as_array)
                .is_some_and(|words| !words.is_empty())
    };
    for definition in types {
        let Some(id) = definition.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some((name, _)) = definition
            .get("fields")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .find(|(_, field)| field.get("type").and_then(Value::as_str) == Some("status"))
        else {
            continue;
        };
        let mut current = Some(id);
        let mut walked = 0;
        let mut found = false;
        while let Some(at) = current {
            let Some((parent, fields)) = chain.get(at) else {
                break;
            };
            if fields
                .and_then(|fields| fields.get(name))
                .is_some_and(has_words)
            {
                found = true;
                break;
            }
            walked += 1;
            if walked > MAX_PARENT_WALK || *parent == Some(at) {
                break;
            }
            current = *parent;
        }
        if !found {
            return Err(RuleError::invalid(format!(
                "{id} declares {name} as status with no status_values, and no type above it gives the field its words"
            )));
        }
    }
    Ok(())
}

/// The groups every status word belongs to one of.
pub const STATUS_GROUPS: [&str; 4] = ["not_started", "in_progress", "completed", "canceled"];

/// A lowercase letter, then up to 63 lowercase letters, digits and underscores.
pub fn api_name(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 64
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

/// Refuses a status word list on a field that is not `status`, a list that is not `{ value, group }` pairs naming each word once in one of the four groups, `enum_values` on a status field, and `status` as an array's element type. A status field with no words is judged by [`refuse_wordless_status`].
pub fn status_declaration(kind: &str, definition: &Value) -> Option<String> {
    if definition.get("items_type").and_then(Value::as_str) == Some("status") {
        return Some(
            "with status elements; an item has one status, in a field of type status".into(),
        );
    }
    let words = definition.get("status_values");
    if kind != "status" {
        return words
            .map(|_| format!("as {kind:?} with status_values, which only a status field takes"));
    }
    if definition.get("enum_values").is_some() {
        return Some(
            "as status with enum_values; a status field lists its words in status_values".into(),
        );
    }
    let words = match words? {
        Value::Array(words) if !words.is_empty() => words,
        _ => return Some("as status with status_values that is not a list of words".into()),
    };
    let mut seen = Vec::new();
    for entry in words {
        let Some(pair) = entry.as_object().filter(|pair| {
            pair.len() == 2 && pair.contains_key("value") && pair.contains_key("group")
        }) else {
            return Some(format!(
                "with the status word {entry}, which is not an object of exactly value and group"
            ));
        };
        let Some(word) = pair["value"].as_str().filter(|word| api_name(word)) else {
            return Some(format!(
                "with the status word {}, which is not a lowercase letter then up to 63 lowercase letters, digits and underscores",
                pair["value"]
            ));
        };
        if seen.contains(&word) {
            return Some(format!("with the status word {word:?} more than once"));
        }
        seen.push(word);
        if !pair["group"]
            .as_str()
            .is_some_and(|group| STATUS_GROUPS.contains(&group))
        {
            return Some(format!(
                "with the status word {word:?} in the group {}, which is not one of {}",
                pair["group"],
                STATUS_GROUPS.join(", ")
            ));
        }
    }
    None
}

/// Refuses a `maxLength` on a currency, `items_fields` on anything but an array of objects, no member in it, or a member that is not an object with a plain value's kind. A member is held to a field's checks: no status word list, no currency `maxLength`, no `items_fields`.
fn entries_declaration(kind: &str, definition: &Value) -> Result<Option<String>, RuleError> {
    let currency_length = |definition: &Value| {
        definition.get("format").and_then(Value::as_str) == Some("currency")
            && definition.get("maxLength").is_some()
    };
    let bound = "with a maxLength on a currency, which is always three capital letters";
    if currency_length(definition) {
        return Ok(Some(bound.into()));
    }
    let Some(members) = definition.get("items_fields") else {
        return Ok(None);
    };
    if kind != "array" || definition.get("items_type").and_then(Value::as_str) != Some("object") {
        return Ok(Some(
            "with items_fields, which only an array of objects takes".into(),
        ));
    }
    let Some(members) = members.as_object().filter(|members| !members.is_empty()) else {
        return Ok(Some(
            "with items_fields that names no member; name each member of an entry".into(),
        ));
    };
    let kinds = crate::builtin::entry_member_types()?;
    for (member, held) in members {
        let Some(held_kind) = held.get("type").and_then(Value::as_str) else {
            return Ok(Some(format!(
                "with the member {member} not an object that names its type"
            )));
        };
        if !kinds.iter().any(|allowed| allowed == held_kind) {
            return Ok(Some(format!(
                "with the member {member} as {held_kind:?}, which an entry does not take: one of {}",
                kinds.join(", ")
            )));
        }
        if let Some(problem) = status_declaration(held_kind, held) {
            return Ok(Some(format!("with the member {member} {problem}")));
        }
        if let Some(problem) = entries_declaration(held_kind, held)? {
            return Ok(Some(format!("with the member {member} {problem}")));
        }
    }
    Ok(None)
}

/// A string whose `format` is a kind of its own is that kind; an array of strings whose `format` is `url`, `email`, `datetime` or `date` is an array of that kind; each member of a list's entries is folded the same way. Every other format annotates the string and stays, as does a `thumbnail` format on an array, which is refused.
fn normalized(definition: &Value) -> Result<Value, RuleError> {
    let Some(row) = definition.as_object() else {
        return Ok(definition.clone());
    };
    let mut row = row.clone();
    let kind = row
        .get("format")
        .and_then(Value::as_str)
        .and_then(|format| {
            crate::builtin::format_field_types()
                .ok()?
                .get(format)
                .cloned()
        });
    let is_list = row.get("type").and_then(Value::as_str) == Some("array");
    if let Some(kind) = kind.filter(|kind| !(is_list && kind == "thumbnail")) {
        row.remove("format");
        if is_list && row.get("items_type").is_some_and(Value::is_string) {
            row.insert("items_type".into(), Value::String(kind));
        } else if !is_list && row.get("type").is_some_and(Value::is_string) {
            row.insert("type".into(), Value::String(kind));
        }
    }
    if let Some(Value::Object(members)) = row.get("items_fields") {
        let folded = members
            .iter()
            .map(|(name, member)| Ok((name.clone(), normalized(member)?)))
            .collect::<Result<Map<_, _>, RuleError>>()?;
        row.insert("items_fields".into(), Value::Object(folded));
    }
    Ok(Value::Object(row))
}

/// Each field folded by [`normalized`]. A declared type is folded as it is read; a listed one already is.
pub fn normalized_type(definition: &Value) -> Result<Value, RuleError> {
    let mut row = definition.clone();
    if let Some(Value::Object(fields)) = row.get("fields") {
        let folded = fields
            .iter()
            .map(|(name, held)| Ok((name.clone(), normalized(held)?)))
            .collect::<Result<Map<_, _>, RuleError>>()?;
        row["fields"] = Value::Object(folded);
    }
    Ok(row)
}

fn text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

fn texts(row: &Map<String, Value>, key: &str) -> Vec<String> {
    row.get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn field(name: &str, definition: &Value, declared_by: &str) -> Result<TypeField, RuleError> {
    let Some(kind) = definition.get("type").and_then(Value::as_str) else {
        return Err(RuleError::decoding(format!(
            "{declared_by} declares {name} with no type"
        )));
    };
    Ok(TypeField {
        name: name.to_string(),
        r#type: kind.to_string(),
        required: definition.get("required").and_then(Value::as_bool) == Some(true),
        label: definition
            .get("label")
            .and_then(Value::as_str)
            .map_or_else(|| label_from_name(name), str::to_string),
        description: definition
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        declared_by: declared_by.to_string(),
        definition: definition.clone(),
    })
}

/// Every label filled: a field or entry member that names none takes the one its name makes.
fn with_labels(name: &str, definition: &Value) -> Value {
    let mut definition = definition.clone();
    let Value::Object(fields) = &mut definition else {
        return definition;
    };
    fill_label(fields, name);
    if let Some(Value::Object(members)) = fields.get_mut("items_fields") {
        for (member, entry) in members.iter_mut() {
            if let Value::Object(entry) = entry {
                fill_label(entry, member);
            }
        }
    }
    definition
}

fn fill_label(definition: &mut Map<String, Value>, name: &str) {
    if !definition.get("label").is_some_and(Value::is_string) {
        definition.insert("label".into(), Value::String(label_from_name(name)));
    }
}

/// One field's definition after a type in the chain declares it again: a
/// `status` field declared again as `status` keeps the words above it and adds
/// its new ones after them, and any other declaration replaces the one above.
pub fn merge_field_definition(inherited: Option<&Value>, own: &Value) -> Value {
    let (Some(Value::Object(above)), Value::Object(below)) = (inherited, own) else {
        return own.clone();
    };
    if status_kind(above) != Some("status") || status_kind(below) != Some("status") {
        return Value::Object(with_labels_above(above, below));
    }
    let words = |definition: &Map<String, Value>| {
        definition
            .get("status_values")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut joined = words(above);
    for entry in words(below) {
        if !joined
            .iter()
            .any(|held| held.get("value") == entry.get("value"))
        {
            joined.push(entry);
        }
    }
    let mut merged = above.clone();
    merged.extend(below.clone());
    merged.insert("status_values".into(), Value::Array(joined));
    Value::Object(merged)
}

/// A declaration that names no label keeps the one above it, for the field and each entry member.
fn with_labels_above(above: &Map<String, Value>, below: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = below.clone();
    if !merged.contains_key("label")
        && let Some(label) = above.get("label")
    {
        merged.insert("label".into(), label.clone());
    }
    if let (Some(Value::Object(members)), Some(Value::Object(members_above))) =
        (merged.get_mut("items_fields"), above.get("items_fields"))
    {
        for (name, member) in members.iter_mut() {
            if let (Value::Object(member), Some(label)) = (
                member,
                members_above.get(name).and_then(|entry| entry.get("label")),
            ) && !member.contains_key("label")
            {
                member.insert("label".into(), label.clone());
            }
        }
    }
    merged
}

fn status_kind(definition: &Map<String, Value>) -> Option<&str> {
    definition.get("type").and_then(Value::as_str)
}

/// A type's one `status` field as it resolves: its name and its words, each with its group, in chain order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusField {
    pub type_id: String,
    pub name: String,
    pub words: Vec<(String, String)>,
}

impl StatusField {
    fn of(type_id: &str, fields: &Map<String, Value>) -> Option<StatusField> {
        let (name, definition) = fields.iter().find(|(_, definition)| {
            definition.get("type").and_then(Value::as_str) == Some("status")
        })?;
        let words = definition
            .get("status_values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                Some((
                    entry.get("value")?.as_str()?.to_string(),
                    entry.get("group")?.as_str()?.to_string(),
                ))
            })
            .collect();
        Some(StatusField {
            type_id: type_id.to_string(),
            name: name.clone(),
            words,
        })
    }

    pub fn group_of(&self, value: &Value) -> Option<&str> {
        let word = value.as_str()?;
        self.words
            .iter()
            .find(|(declared, _)| declared == word)
            .map(|(_, group)| group.as_str())
    }
}

/// Fields merged from the root down, the nearer declaration winning. The listing already answers `roles` resolved.
pub fn resolve_item_type(
    id: &str,
    held: &HashMap<String, Map<String, Value>>,
    hints: &Catalog,
) -> Result<Option<ItemType>, RuleError> {
    let mut chain: Vec<(&str, &Map<String, Value>)> = Vec::new();
    let mut current = Some(id);
    while let Some(at) = current {
        let Some(row) = held.get(at) else { break };
        if chain.len() >= MAX_PARENT_WALK || chain.iter().any(|(seen, _)| *seen == at) {
            return Err(RuleError::decoding(format!(
                "{id}'s parent chain loops or runs past {MAX_PARENT_WALK} types, so its fields cannot be resolved"
            )));
        }
        chain.push((at, row));
        current = row.get("parent").and_then(Value::as_str);
    }
    let Some((_, own)) = chain.first().copied() else {
        return Ok(None);
    };
    let tables = crate::schema::chain_tables(chain.iter().rev().map(|(_, row)| *row));
    let mut fields: BTreeMap<String, TypeField> = BTreeMap::new();
    for (declaring, row) in chain.iter().rev() {
        if let Some(declared) = row.get("fields").and_then(Value::as_object) {
            for (name, definition) in declared {
                let merged = merge_field_definition(
                    fields.get(name).map(|above| &above.definition),
                    definition,
                );
                fields.insert(name.clone(), field(name, &merged, declaring)?);
            }
        }
    }
    for held in fields.values_mut() {
        held.definition = with_labels(&held.name, &held.definition);
    }
    let label = text(own, "label");
    let plural = text(own, "plural")
        .filter(|plural| !plural.is_empty())
        .unwrap_or_else(|| {
            plural_from_label(
                &label
                    .clone()
                    .filter(|label| !label.is_empty())
                    .unwrap_or_else(|| label_from_id(id)),
            )
        });
    Ok(Some(ItemType {
        id: id.to_string(),
        label,
        plural,
        description: text(own, "description"),
        parent: text(own, "parent"),
        version: own.get("version").and_then(Value::as_f64).unwrap_or(0.0) as i64,
        fields: fields.into_values().collect(),
        tables: crate::schema::with_table_labels(&tables),
        title_field: hints.title_field(id).map(str::to_string),
        body_field: hints.body_field(id).map(str::to_string),
        name_from_body: hints.name_from_body(id),
        icon: hints.icon(id).map(str::to_string),
        link_field: text(own, "link_field"),
        roles: texts(own, "roles"),
        compatible_with: texts(own, "compatible_with"),
    }))
}

/// A held type with the types above it, itself first, and every role it plays.
pub struct Lineage {
    pub ancestors: Vec<String>,
    pub roles: Vec<String>,
    /// Whether the walk reached the top of the chain: a parent the copy does
    /// not hold, or a chain that loops, leaves what is above unknown.
    pub whole: bool,
}

impl Lineage {
    /// By the server's rule: an empty list or `*` admits every type, `role:<name>` a type that plays it, a type id that type and every type beneath it. `None` where only the unreadable part of the chain would tell.
    pub fn admitted_by(&self, constraints: &[String]) -> Option<bool> {
        let admitted = constraints.is_empty()
            || constraints.iter().any(|allowed| {
                allowed == "*"
                    || match allowed.strip_prefix("role:") {
                        Some(role) => self.roles.iter().any(|held| held == role),
                        None => self.ancestors.iter().any(|held| held == allowed),
                    }
            });
        (admitted || self.whole).then_some(admitted)
    }
}

pub fn lineage_of(held: &HashMap<String, Map<String, Value>>, id: &str) -> Option<Lineage> {
    if !held.contains_key(id) {
        return None;
    }
    let mut lineage = Lineage {
        ancestors: Vec::new(),
        roles: Vec::new(),
        whole: true,
    };
    let mut current = Some(id);
    while let Some(at) = current {
        if lineage.ancestors.len() >= MAX_PARENT_WALK
            || lineage.ancestors.iter().any(|seen| seen == at)
        {
            lineage.whole = false;
            break;
        }
        // A parent the copy does not hold is still an ancestor a type constraint can name.
        lineage.ancestors.push(at.to_string());
        let Some(row) = held.get(at) else {
            lineage.whole = false;
            break;
        };
        for role in texts(row, "roles") {
            if !lineage.roles.contains(&role) {
                lineage.roles.push(role);
            }
        }
        current = row.get("parent").and_then(Value::as_str);
    }
    Some(lineage)
}

/// The four properties search reads whether or not a type declares them. A thumbnail may not take one of these names.
pub const CORE_TEXT_FIELDS: [&str; 4] = ["title", "body", "description", "name"];

/// What the local index reads from an item's properties.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Indexing {
    /// Core properties declared as strings and marked `searchable: false`.
    pub opted_out: Vec<String>,
    /// Other declared or inherited string properties not marked `searchable: false`, in name order.
    pub extra: Vec<String>,
}

/// The type catalog as last hydrated, answering the subtree question `?type=` answers: exact name, dotted-name descendant, or a type whose declared parent chain reaches the root.
#[derive(Debug)]
pub struct Catalog {
    entries: HashMap<String, CatalogEntry>,
    /// What the root last said a request may carry; a write is held to it.
    request_limit: Option<usize>,
}

const MAX_PARENT_WALK: usize = 64;

impl Catalog {
    /// A catalog that declares no type: every type reads its title and body from the default properties.
    pub fn empty() -> Catalog {
        Catalog {
            entries: HashMap::new(),
            request_limit: None,
        }
    }

    pub fn new(entries: HashMap<String, CatalogEntry>, request_limit: Option<usize>) -> Catalog {
        Catalog {
            entries,
            request_limit,
        }
    }

    pub fn from_wire(types: &[WireType], request_limit: Option<usize>) -> Catalog {
        Catalog::new(
            types
                .iter()
                .map(|held| (held.id.clone(), CatalogEntry::from_wire(held)))
                .collect(),
            request_limit,
        )
    }

    pub fn request_limit(&self) -> Option<usize> {
        self.request_limit
    }

    /// Refuses `properties` as an item of `type_id`, `complete` where they are the whole item. A status word is judged only where the write sets it; `validate_merged` judges the item a write leaves.
    pub fn validate_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        complete: bool,
    ) -> Result<(), RuleError> {
        self.validate_merged(type_id, properties, complete, properties)
    }

    /// A status word is judged only where `written`, the properties the write changes, sets it: a stored word the type does not declare does not refuse a write that leaves it alone or sends it back unchanged.
    pub fn validate_merged(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        complete: bool,
        written: &Map<String, Value>,
    ) -> Result<(), RuleError> {
        if !self.known(type_id) {
            return Err(RuleError::new(
                Code::UnknownType,
                format!("{type_id} is not a type this copy holds"),
            ));
        }
        let mut resolved = self.resolved(type_id)?;
        if let Some(definition) = self
            .body_field(type_id)
            .and_then(|body| resolved.get_mut(body))
            .and_then(Value::as_object_mut)
            .filter(|definition| definition.get("type").and_then(Value::as_str) == Some("string"))
        {
            definition
                .entry("maxLength")
                .or_insert(json!(crate::validation::BODY_MAX_LENGTH));
        }
        let every: Vec<(&str, Value)> = EVERY_TYPE_TAKES
            .iter()
            .map(|(name, items)| (*name, json!({ "type": "array", "items_type": items })))
            .collect();
        let mut fields = BTreeMap::new();
        for (name, definition) in &every {
            fields.insert(*name, definition);
        }
        for (name, definition) in &resolved {
            fields.insert(name.as_str(), definition);
        }
        crate::validation::properties(&fields, properties, complete)?;
        if written.contains_key(OWN_COLUMNS) && self.keeps_own_table(type_id) {
            self.judge_own_columns(properties.get(OWN_COLUMNS))?;
        }
        if complete {
            self.judge_schedule(type_id, properties)?;
        }
        if let Some(status) = StatusField::of(type_id, &resolved)
            && let Some(value) = written.get(&status.name)
            && !value.is_null()
            && status.group_of(value).is_none()
        {
            let words: Vec<&str> = status.words.iter().map(|(word, _)| word.as_str()).collect();
            let message = format!(
                "Must be a status word the type declares: {}",
                words.join(", ")
            );
            return Err(RuleError::new(
                Code::InvalidProperties,
                format!("{}: {message}", status.name),
            )
            .with_fields(vec![FieldError::new(
                status.name.clone(),
                field_code::INVALID_VALUE,
                message,
            )]));
        }
        Ok(())
    }

    pub fn keeps_own_table(&self, type_id: &str) -> bool {
        type_id == OWN_TABLE_TYPE || self.descends_from(type_id, OWN_TABLE_TYPE)
    }

    fn judge_own_columns(&self, columns: Option<&Value>) -> Result<(), RuleError> {
        judge_item_columns(columns, &|id| self.known(id))
            .map(drop)
            .map_err(|issues| {
                let message = issues
                    .iter()
                    .map(|issue| format!("{}: {}", issue.field, issue.message()))
                    .collect::<Vec<_>>()
                    .join("; ");
                let fields = issues
                    .iter()
                    .map(|issue| {
                        FieldError::new(
                            issue.field.clone(),
                            field_code::INVALID_VALUE,
                            issue.message(),
                        )
                    })
                    .collect();
                RuleError::new(Code::InvalidProperties, message).with_fields(fields)
            })
    }

    /// An event's schedule and a task's `recurrence` are judged on the item a write leaves.
    pub fn judge_schedule(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Result<(), RuleError> {
        let issues = if self.matches("core.event", type_id) {
            crate::recurrence::event_issues(properties)
        } else if self.matches("core.task", type_id) {
            crate::recurrence::task_issues(properties)
        } else {
            return Ok(());
        };
        if issues.is_empty() {
            return Ok(());
        }
        let summary = issues
            .iter()
            .map(|issue| format!("{}: {}", issue.field, issue.message))
            .collect::<Vec<_>>()
            .join("; ");
        Err(
            RuleError::new(Code::InvalidProperties, summary).with_fields(
                issues
                    .into_iter()
                    .map(|issue| {
                        FieldError::new(issue.field, field_code::INVALID_VALUE, issue.message)
                    })
                    .collect(),
            ),
        )
    }

    /// Merged root to leaf. A type the copy does not hold declares none.
    pub fn resolved(&self, type_id: &str) -> Result<Map<String, Value>, RuleError> {
        let mut chain = Vec::new();
        let mut current = Some(type_id);
        while let Some(at) = current {
            let Some(entry) = self.entries.get(at) else {
                break;
            };
            if chain.len() >= MAX_PARENT_WALK || chain.iter().any(|(seen, _)| *seen == at) {
                return Err(RuleError::decoding(format!(
                    "{type_id}'s fields cannot be resolved because its parent chain loops or runs past {MAX_PARENT_WALK} types"
                )));
            }
            chain.push((at, entry));
            current = entry.parent.as_deref();
        }
        let mut fields = Map::new();
        for (_, entry) in chain.into_iter().rev() {
            for (name, definition) in &entry.definitions {
                let merged = merge_field_definition(fields.get(name), definition);
                fields.insert(name.clone(), merged);
            }
        }
        Ok(fields)
    }

    /// A type whose chain cannot be resolved has none.
    pub fn status_fields(&self) -> Vec<StatusField> {
        let mut fields: Vec<StatusField> = self
            .entries
            .keys()
            .filter_map(|id| StatusField::of(id, &self.resolved(id).ok()?))
            .collect();
        fields.sort_by(|a, b| a.type_id.cmp(&b.type_id));
        fields
    }

    /// A null on a field the type declares and does not require is dropped; one on an undeclared property is kept.
    pub fn created_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Map<String, Value> {
        let resolved = self.resolved(type_id).unwrap_or_default();
        properties
            .iter()
            .filter(|(name, value)| {
                !value.is_null()
                    || match resolved.get(*name) {
                        Some(definition) => Self::required(definition),
                        None => !EVERY_TYPE_TAKES
                            .iter()
                            .any(|(every, _)| *every == name.as_str()),
                    }
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }

    /// A `url` field, an array of `url` elements and a `url` list member hold the trimmed address. A value the field would refuse is left for validation to name.
    pub fn coerced_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Map<String, Value> {
        let kept = |value: &Value| match value.as_str().and_then(crate::validation::url_value) {
            Some(url) => Value::String(url),
            None => value.clone(),
        };
        let resolved = self.resolved(type_id).unwrap_or_default();
        properties
            .iter()
            .map(|(name, value)| {
                let definition = resolved.get(name);
                let field = |key| {
                    definition
                        .and_then(|definition| definition.get(key))
                        .and_then(Value::as_str)
                };
                let members = definition
                    .and_then(|definition| definition.get("items_fields"))
                    .and_then(Value::as_object);
                let coerced = match (field("type"), value) {
                    (Some("url"), _) => kept(value),
                    (Some("array"), Value::Array(values)) if field("items_type") == Some("url") => {
                        Value::Array(values.iter().map(kept).collect())
                    }
                    (Some("array"), Value::Array(values))
                        if field("items_type") == Some("object") && members.is_some() =>
                    {
                        let members = members.into_iter().flatten();
                        let urls: Vec<&String> = members
                            .filter(|(_, member)| {
                                member.get("type").and_then(Value::as_str) == Some("url")
                            })
                            .map(|(member, _)| member)
                            .collect();
                        Value::Array(
                            values
                                .iter()
                                .map(|entry| match entry {
                                    Value::Object(entry) => Value::Object(
                                        entry
                                            .iter()
                                            .map(|(member, held)| {
                                                let held = if urls.contains(&member) {
                                                    kept(held)
                                                } else {
                                                    held.clone()
                                                };
                                                (member.clone(), held)
                                            })
                                            .collect(),
                                    ),
                                    other => other.clone(),
                                })
                                .collect(),
                        )
                    }
                    _ => value.clone(),
                };
                (name.clone(), coerced)
            })
            .collect()
    }

    pub fn requires(&self, type_id: &str, name: &str) -> bool {
        self.resolved(type_id)
            .ok()
            .and_then(|fields| fields.get(name).map(Self::required))
            .unwrap_or(false)
    }

    fn required(definition: &Value) -> bool {
        definition.get("required").and_then(Value::as_bool) == Some(true)
    }

    /// Applies the null rule to the local projection; the queued request stays unchanged so the server validates what the caller sent.
    pub fn projected_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        replace: bool,
    ) -> Map<String, Value> {
        let known = self.known(type_id);
        let resolved = self.resolved(type_id).unwrap_or_default();
        properties
            .iter()
            .filter(|(name, value)| {
                if !value.is_null() {
                    return true;
                }
                if replace {
                    return false;
                }
                !known || resolved.get(*name).is_some_and(Self::required)
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }

    /// The fields the type declares come first, in the order a read of the type lists them (parent's before its own; a redeclared field keeps its first place), then the rest as given.
    pub fn in_answer_order(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Map<String, Value> {
        let mut chain = Vec::new();
        let mut current = Some(type_id);
        while let Some(at) = current {
            let Some(entry) = self.entries.get(at) else {
                break;
            };
            if chain.len() >= MAX_PARENT_WALK {
                break;
            }
            chain.push(entry);
            current = entry.parent.as_deref();
        }
        let mut ordered = Map::new();
        for entry in chain.into_iter().rev() {
            for name in &entry.fields {
                if let Some(value) = properties.get(name)
                    && !ordered.contains_key(name)
                {
                    ordered.insert(name.clone(), value.clone());
                }
            }
        }
        for (name, value) in properties {
            if !ordered.contains_key(name) {
                ordered.insert(name.clone(), value.clone());
            }
        }
        ordered
    }

    /// `core.media.*` and `core.media` name the same subtree.
    pub fn root(declared: &str) -> &str {
        declared.strip_suffix(".*").unwrap_or(declared)
    }

    pub fn matches(&self, declared: &str, actual: &str) -> bool {
        let root = Self::root(declared);
        if actual == root || actual.starts_with(&format!("{root}.")) {
            return true;
        }
        self.descends_from(actual, root)
    }

    pub fn descendants<'a>(&'a self, root: &'a str) -> impl Iterator<Item = &'a str> {
        self.entries
            .keys()
            .map(String::as_str)
            .filter(move |id| *id != root && self.matches(root, id))
    }

    /// Types that reach `root` only through declared parentage, so a SQL
    /// filter can name them alongside the `root.%` pattern.
    pub fn declared_descendants(&self, root: &str) -> Vec<String> {
        let prefix = format!("{root}.");
        let mut ids: Vec<String> = self
            .entries
            .keys()
            .filter(|id| id.as_str() != root && !id.starts_with(&prefix))
            .filter(|id| self.descends_from(id, root))
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// The server refuses a create of an unknown type with `400 unknown_type` after the caller was told it was queued, so it is checked here first.
    pub fn known(&self, type_id: &str) -> bool {
        self.entries.contains_key(type_id)
    }

    /// Each display hint is inherited on its own, so a subtype naming only its body keeps its parent's title.
    pub fn title_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.title_field.as_deref())
    }

    /// True where no type says.
    pub fn name_from_body(&self, type_id: &str) -> bool {
        self.nearest(type_id, |entry| entry.name_from_body)
            .unwrap_or(true)
    }

    pub fn body_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.body_field.as_deref())
    }

    /// The catalog holds the owner's choice in the type's own place, so it is inherited like any other.
    pub fn icon(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.icon.as_deref())
    }

    /// Its hints' title field, or `title`.
    pub fn title_property(&self, type_id: &str) -> &str {
        self.title_field(type_id).unwrap_or(TITLE_PROPERTY)
    }

    /// Its hints' body field, or `body`.
    pub fn body_property(&self, type_id: &str) -> &str {
        self.body_field(type_id).unwrap_or(BODY_PROPERTY)
    }

    /// A value that is not a string shows as none.
    pub fn title_and_body(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> (Option<String>, Option<String>) {
        let text = |property: &str| {
            properties
                .get(property)
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        (
            text(self.title_property(type_id)),
            text(self.body_property(type_id)),
        )
    }

    pub fn display(&self, type_id: &str, properties: &Map<String, Value>) -> ItemDisplay {
        crate::display::display(
            properties,
            self.title_field(type_id),
            self.body_field(type_id),
            self.name_from_body(type_id),
        )
    }

    pub fn declared(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.entries
            .iter()
            .map(|(id, entry)| (id.as_str(), entry.fields.as_slice()))
    }

    /// Its own or inherited; the listing answers each type as declared, not resolved.
    pub fn thumbnail_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.thumbnail_field.as_deref())
    }

    /// A type the catalog does not hold, or one whose parent it does not, resolves as far as the catalog reaches; an unknown type contributes its core properties alone.
    pub fn indexing(&self, type_id: &str) -> Indexing {
        let mut chain: Vec<&CatalogEntry> = Vec::new();
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let Some(entry) = self.entries.get(current) else {
                break;
            };
            chain.push(entry);
            match entry.parent.as_deref() {
                Some(parent) => current = parent,
                None => break,
            }
        }
        // A nearer declaration replaces the definition and keeps the place
        // the farther one gave the name.
        let mut resolved: Vec<(&String, &Value)> = Vec::new();
        for entry in chain.into_iter().rev() {
            for (name, definition) in &entry.definitions {
                match resolved.iter_mut().find(|(held, _)| *held == name) {
                    Some(held) => held.1 = definition,
                    None => resolved.push((name, definition)),
                }
            }
        }
        let mut indexing = Indexing::default();
        for (name, definition) in resolved {
            let string = definition.get("type").and_then(Value::as_str) == Some("string");
            let searchable = definition.get("searchable").and_then(Value::as_bool) != Some(false);
            if CORE_TEXT_FIELDS.contains(&name.as_str()) {
                if string && !searchable {
                    indexing.opted_out.push(name.clone());
                }
            } else if string && searchable {
                indexing.extra.push(name.clone());
            }
        }
        // Name order, so a phrase that crosses two fields matches on both or on neither.
        indexing.extra.sort();
        indexing
    }

    fn nearest<'a, T>(
        &'a self,
        type_id: &str,
        read: impl Fn(&'a CatalogEntry) -> Option<T>,
    ) -> Option<T> {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let entry = self.entries.get(current)?;
            if let Some(found) = read(entry) {
                return Some(found);
            }
            current = entry.parent.as_deref()?;
        }
        None
    }

    fn descends_from(&self, type_id: &str, root: &str) -> bool {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let Some(entry) = self.entries.get(current) else {
                return false;
            };
            let Some(parent) = entry.parent.as_deref() else {
                return false;
            };
            if parent == root {
                return true;
            }
            current = parent;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Code;

    fn catalog(pairs: &[(&str, Option<&str>)]) -> Catalog {
        Catalog {
            entries: pairs
                .iter()
                .map(|(id, parent)| {
                    (
                        id.to_string(),
                        CatalogEntry {
                            parent: parent.map(str::to_string),
                            title_field: None,
                            thumbnail_field: None,
                            body_field: None,
                            name_from_body: None,
                            icon: None,
                            fields: Vec::new(),
                            definitions: Map::new(),
                        },
                    )
                })
                .collect(),
            request_limit: None,
        }
    }

    fn with_bodies(parent_body: Option<&str>, child_body: Option<&str>) -> Catalog {
        let mut catalog = catalog(&[("parent", None), ("child", Some("parent"))]);
        let parent = catalog.entries.get_mut("parent").unwrap();
        parent.body_field = parent_body.map(str::to_string);
        parent.definitions = serde_json::json!({
            "description": {"type": "string"},
            "body": {"type": "string"},
        })
        .as_object()
        .unwrap()
        .clone();
        catalog.entries.get_mut("child").unwrap().body_field = child_body.map(str::to_string);
        catalog
    }

    fn refused_field(
        catalog: &Catalog,
        type_id: &str,
        field: &str,
        text: String,
    ) -> Option<String> {
        let mut properties = Map::new();
        properties.insert(field.to_string(), Value::String(text));
        catalog
            .validate_properties(type_id, &properties, false)
            .err()
            .map(|refusal| match refusal {
                error if matches!(error.code, Code::ValidationError | Code::InvalidProperties) => {
                    error
                        .message
                        .split(':')
                        .next()
                        .unwrap_or_default()
                        .to_string()
                }
                other => panic!("expected a validation refusal, got {other:?}"),
            })
    }

    fn held(types: serde_json::Value) -> Vec<WireType> {
        serde_json::from_value(types).unwrap()
    }

    #[test]
    fn a_named_body_holds_a_million_characters_and_other_text_a_hundred_thousand() {
        let catalog = with_bodies(Some("body"), None);
        let refused = |field, text| refused_field(&catalog, "parent", field, text);
        assert_eq!(refused("body", "x".repeat(1_000_000)), None);
        assert_eq!(
            refused("body", "x".repeat(1_000_001)).as_deref(),
            Some("body")
        );
        assert_eq!(refused("description", "x".repeat(100_000)), None);
        assert_eq!(
            refused("description", "x".repeat(100_001)).as_deref(),
            Some("description")
        );
    }

    #[test]
    fn a_character_outside_the_basic_plane_counts_one_against_both_limits() {
        let catalog = with_bodies(Some("body"), None);
        let refused = |field, text| refused_field(&catalog, "parent", field, text);
        let astral = |before| format!("{}\u{1F600}", "x".repeat(before));
        assert_eq!(refused("body", astral(999_999)), None);
        assert_eq!(refused("body", astral(1_000_000)).as_deref(), Some("body"));
        assert_eq!(refused("description", astral(99_999)), None);
        assert_eq!(
            refused("description", astral(100_000)).as_deref(),
            Some("description")
        );
    }

    #[test]
    fn a_body_follows_the_nearest_type_that_names_one() {
        let long = || "x".repeat(100_001);
        let inherits = with_bodies(Some("description"), None);
        assert_eq!(
            refused_field(&inherits, "child", "description", long()),
            None
        );
        assert_eq!(
            refused_field(&inherits, "child", "body", long()).as_deref(),
            Some("body")
        );
        let renames = with_bodies(Some("description"), Some("body"));
        assert_eq!(
            refused_field(&renames, "parent", "description", long()),
            None
        );
        assert_eq!(
            refused_field(&renames, "child", "description", long()).as_deref(),
            Some("description")
        );
        assert_eq!(refused_field(&renames, "child", "body", long()), None);
    }

    #[test]
    fn a_field_called_body_on_a_type_naming_none_keeps_the_shorter_limit() {
        let catalog = with_bodies(None, None);
        assert_eq!(
            refused_field(&catalog, "child", "body", "x".repeat(100_000)),
            None
        );
        assert_eq!(
            refused_field(&catalog, "child", "body", "x".repeat(100_001)).as_deref(),
            Some("body")
        );
    }

    #[test]
    fn a_body_fields_own_length_wins_in_both_directions() {
        let declaring = |max: u64| {
            let mut catalog = with_bodies(Some("body"), None);
            catalog.entries.get_mut("parent").unwrap().definitions = serde_json::json!({
                "body": {"type": "string", "maxLength": max},
            })
            .as_object()
            .unwrap()
            .clone();
            catalog
        };
        let lower = declaring(50);
        assert_eq!(
            refused_field(&lower, "parent", "body", "x".repeat(50)),
            None
        );
        assert_eq!(
            refused_field(&lower, "parent", "body", "x".repeat(51)).as_deref(),
            Some("body")
        );
        let higher = declaring(2_000_000);
        assert_eq!(
            refused_field(&higher, "parent", "body", "x".repeat(1_000_001)),
            None
        );
        assert_eq!(
            refused_field(&higher, "parent", "body", "x".repeat(2_000_001)).as_deref(),
            Some("body")
        );
    }

    #[test]
    fn projected_nulls_follow_the_destination_type_and_replace_mode() {
        let mut catalog = catalog(&[("parent", None), ("child", Some("parent"))]);
        catalog.entries.get_mut("parent").unwrap().definitions =
            serde_json::json!({"body": {"required": true}, "title": {"required": false}})
                .as_object()
                .unwrap()
                .clone();
        catalog.entries.get_mut("child").unwrap().definitions =
            serde_json::json!({"title": {"required": true}})
                .as_object()
                .unwrap()
                .clone();
        let input =
            serde_json::json!({ "body": null, "title": null, "extra": null, "notes": "kept" });
        let properties = input.as_object().unwrap();
        assert_eq!(
            serde_json::Value::Object(catalog.projected_properties("parent", properties, false)),
            serde_json::json!({ "body": null, "notes": "kept" })
        );
        assert_eq!(
            serde_json::Value::Object(catalog.projected_properties("child", properties, false)),
            serde_json::json!({ "body": null, "title": null, "notes": "kept" })
        );
        assert_eq!(
            serde_json::Value::Object(catalog.projected_properties("child", properties, true)),
            serde_json::json!({ "notes": "kept" })
        );
        assert_eq!(
            catalog.projected_properties("unknown", properties, false),
            *properties
        );
        assert!(properties["title"].is_null());
    }

    #[test]
    fn exact_prefix_and_declared_parentage_all_match() {
        let catalog = catalog(&[
            ("core.media", None),
            ("core.media.song", Some("core.media")),
            ("acme.podcast", Some("core.media")),
            ("acme.episode", Some("acme.podcast")),
            ("core.note", None),
        ]);
        assert!(catalog.matches("core.media", "core.media"));
        assert!(catalog.matches("core.media.*", "core.media.song"));
        assert!(catalog.matches("core.media", "core.media.song.remix"));
        assert!(catalog.matches("core.media", "acme.podcast"));
        assert!(catalog.matches("core.media", "acme.episode"));
        assert!(!catalog.matches("core.media", "core.note"));
        assert!(!catalog.matches("core.media", "core.mediafile"));
        assert_eq!(
            catalog.declared_descendants("core.media"),
            vec!["acme.episode".to_string(), "acme.podcast".to_string()]
        );
    }

    #[test]
    fn a_create_is_held_in_the_order_the_server_answers_it() {
        let types = held(serde_json::json!([
            { "id": "acme.parent",
              "fields": { "zeta": { "type": "string" }, "alpha": { "type": "string" } } },
            { "id": "acme.child", "parent": "acme.parent",
              "fields": { "mid": { "type": "string" }, "beta": { "type": "string" },
                          "alpha": { "type": "string", "description": "again" } } }
        ]));
        let catalog = Catalog::from_wire(&types, None);
        let sent: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "extra1": "x", "beta": "b", "alpha": "a", "extra0": "y", "zeta": "z", "mid": "m"
        }))
        .unwrap();
        let keys = |type_id: &str| -> Vec<String> {
            catalog
                .in_answer_order(type_id, &sent)
                .keys()
                .cloned()
                .collect()
        };
        assert_eq!(
            keys("acme.child"),
            ["zeta", "alpha", "mid", "beta", "extra1", "extra0"],
            "a create was held in another order than the server answers it"
        );
        assert_eq!(
            keys("acme.unheld"),
            ["extra1", "beta", "alpha", "extra0", "zeta", "mid"],
            "a type the catalog does not hold moved a property"
        );
    }

    #[test]
    fn a_held_array_field_and_the_universal_ones_judge_their_elements() {
        let types = held(serde_json::json!([
            { "id": "acme.base",
              "fields": { "to": { "type": "array", "items_type": "string" } } },
            { "id": "acme.leaf", "parent": "acme.base", "fields": {} }
        ]));
        let catalog = Catalog::from_wire(&types, None);
        let judge = |properties: Value| {
            let properties: Map<String, Value> = serde_json::from_value(properties).unwrap();
            catalog.validate_properties("acme.leaf", &properties, true)
        };
        for good in [
            json!({ "to": ["a"], "links": ["b"], "attachments": [{}] }),
            json!({ "to": [], "links": null, "attachments": [] }),
            json!({}),
        ] {
            assert!(judge(good.clone()).is_ok(), "{good}");
        }
        for bad in [
            json!({ "to": [42] }),
            json!({ "to": ["a", {"x": 1}] }),
            json!({ "links": [1] }),
            json!({ "attachments": ["x"] }),
        ] {
            let refused = judge(bad.clone());
            assert!(
                matches!(&refused, Err(error) if error.code == Code::InvalidProperties),
                "{bad}: {refused:?}"
            );
        }
    }

    #[test]
    fn a_create_holds_its_nulls_as_the_server_does() {
        let types = held(serde_json::json!([
            { "id": "acme.base",
              "fields": { "title": { "type": "string" },
                          "body": { "type": "string", "required": true } } },
            { "id": "acme.leaf", "parent": "acme.base", "fields": {} }
        ]));
        let catalog = Catalog::from_wire(&types, None);
        let sent: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "title": null, "body": null, "links": null, "attachments": null, "extra": null
        }))
        .unwrap();
        assert_eq!(
            catalog
                .created_properties("acme.leaf", &sent)
                .keys()
                .collect::<Vec<_>>(),
            ["body", "extra"],
            "an inherited optional field kept its null, or a required or undeclared one lost it"
        );
    }

    #[test]
    fn a_url_member_of_an_entry_is_kept_trimmed_as_a_url_field_is() {
        let types = held(serde_json::json!([
            { "id": "acme.page",
              "fields": {
                "links": { "type": "array", "items_type": "object",
                  "items_fields": { "u": { "type": "url" }, "v": { "type": "string" } } },
                "plain": { "type": "array", "items_type": "object" }
              } }
        ]));
        let catalog = Catalog::from_wire(&types, None);
        let sent = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "links": [
                { "u": "  https://example.com/b\t ", "v": "  kept  " },
                { "u": "https://exa\nmple.com/c" },
                { "u": "not a url" },
                { "u": 5 },
                { "v": "x" },
                "text"
            ],
            "plain": [{ "u": " https://example.com/ " }]
        }))
        .unwrap();
        let kept = catalog.coerced_properties("acme.page", &sent);
        assert_eq!(
            kept["links"],
            serde_json::json!([
                { "u": "https://example.com/b", "v": "  kept  " },
                { "u": "https://example.com/c" },
                { "u": "not a url" },
                { "u": 5 },
                { "v": "x" },
                "text"
            ])
        );
        assert_eq!(
            kept["plain"], sent["plain"],
            "an object the type declares no members for is kept as written"
        );
    }

    #[test]
    fn indexing_resolves_declared_string_fields_through_the_parents() {
        let types = held(serde_json::json!([
            { "id": "acme.base",
              "fields": {
                "blurb": { "type": "string" },
                "secret": { "type": "string", "searchable": false },
                "title": { "type": "string", "searchable": false },
                "count": { "type": "integer" },
                "cover": { "type": "thumbnail" }
              },
              "display_hints": { "title_field": "blurb" } },
            { "id": "acme.leaf", "parent": "acme.base",
              "fields": {
                "secret": { "type": "string" },
                "blurb": { "type": "string", "searchable": false },
                "note": { "type": "string" },
                "body": { "type": "string", "searchable": false }
              } },
            { "id": "acme.orphan", "parent": "acme.absent",
              "fields": { "own": { "type": "string" } } }
        ]));
        let catalog = Catalog::from_wire(&types, None);
        assert_eq!(
            catalog.indexing("acme.base"),
            Indexing {
                opted_out: vec!["title".into()],
                extra: vec!["blurb".into()],
            }
        );
        assert_eq!(
            catalog.indexing("acme.leaf"),
            Indexing {
                opted_out: vec!["title".into(), "body".into()],
                extra: vec!["note".into(), "secret".into()],
            }
        );
        assert_eq!(
            catalog.indexing("acme.orphan"),
            Indexing {
                opted_out: Vec::new(),
                extra: vec!["own".into()],
            }
        );
        assert_eq!(catalog.indexing("acme.unknown"), Indexing::default());
    }

    #[test]
    fn a_list_of_strings_is_folded_to_its_kind_but_a_thumbnail_list_is_not() {
        let folded = normalized(&serde_json::json!(
            {"type": "array", "items_type": "string", "format": "url"}
        ))
        .unwrap();
        assert_eq!(
            folded,
            serde_json::json!({"type": "array", "items_type": "url"})
        );
        let held = serde_json::json!(
            {"type": "array", "items_type": "string", "format": "thumbnail"}
        );
        assert_eq!(normalized(&held).unwrap(), held);
        let single = normalized(&serde_json::json!(
            {"type": "string", "format": "thumbnail"}
        ))
        .unwrap();
        assert_eq!(single, serde_json::json!({"type": "thumbnail"}));
    }

    #[test]
    fn a_parent_cycle_ends() {
        let catalog = catalog(&[("a", Some("b")), ("b", Some("a"))]);
        assert!(!catalog.matches("z", "a"));
    }

    #[test]
    fn a_resolved_type_holds_the_tables_it_declares_and_inherits_with_their_labels() {
        let held: HashMap<String, Map<String, Value>> = [
            json!({"id": "app.acme.base", "fields": {},
                   "tables": {"lines": {"columns": {"due_at": {"type": "date"}}}}}),
            json!({"id": "app.acme.child", "parent": "app.acme.base", "fields": {},
                   "tables": {"notes": {"label": "Jottings", "columns": {"text": {"type": "string"}}}}}),
        ]
        .into_iter()
        .filter_map(|row| Some((row["id"].as_str()?.to_string(), row.as_object()?.clone())))
        .collect();
        let child = resolve_item_type("app.acme.child", &held, &Catalog::empty())
            .unwrap()
            .unwrap();
        let mut names: Vec<&String> = child.tables.keys().collect();
        names.sort();
        assert_eq!(names, ["lines", "notes"]);
        assert_eq!(child.tables["lines"]["label"], "Lines");
        assert_eq!(
            child.tables["lines"]["columns"]["due_at"]["label"],
            "Due At"
        );
        assert_eq!(child.tables["notes"]["label"], "Jottings");
        let base = resolve_item_type("app.acme.base", &held, &Catalog::empty())
            .unwrap()
            .unwrap();
        assert_eq!(base.tables.len(), 1);
    }
    #[test]
    fn an_item_of_core_table_or_below_is_judged_by_the_validator_a_declared_table_passes() {
        let catalog = Catalog::from_wire(
            &held(json!([
                {"id": "core.table", "fields": {"columns": {"type": "object"}}},
                {"id": "app.acme.ledger", "parent": "core.table", "fields": {}},
                {"id": "core.note", "fields": {}}
            ])),
            None,
        );
        let good = json!({"columns": {"a": {"type": "item", "type_constraints": ["core.table"]}}});
        let bad = json!({"columns": {"a": {"type": "money"}, "B": {"type": "string"}}});
        let judge = |type_id: &str, properties: &Value| {
            catalog.validate_properties(type_id, properties.as_object().unwrap(), true)
        };
        assert!(judge("core.table", &good).is_ok());
        assert!(judge("app.acme.ledger", &good).is_ok());
        let refused = judge("app.acme.ledger", &bad).unwrap_err();
        let paths: Vec<&str> = refused.fields.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["columns.a.type", "columns.B"]);
        assert!(
            judge("core.note", &bad).is_ok(),
            "a note's columns are a property like any other"
        );
        assert!(judge("core.table", &json!({"columns": {}})).is_err());
    }
}
