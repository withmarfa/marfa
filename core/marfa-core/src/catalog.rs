use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{Item, Shown};
use crate::store;
use crate::wire::WireEdgeType;

const TITLE_PROPERTY: &str = "title";

/// Fields the server takes on every type, optional, which no read of a type
/// lists (`items.md` 68).
const EVERY_TYPE_TAKES: [&str; 2] = ["attachments", "links"];
const BODY_PROPERTY: &str = "body";

struct Entry {
    parent: Option<String>,
    /// Whether the type declares a `display_hints` block of its own.
    hinted: bool,
    title_field: Option<String>,
    thumbnail_field: Option<String>,
    body_field: Option<String>,
    /// The properties the type declares itself, not those it inherits.
    fields: Vec<String>,
    definitions: Map<String, Value>,
}

/// The end of an edge whose file writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum End {
    Source,
    Target,
}

impl End {
    pub fn other(self) -> End {
        match self {
            End::Source => End::Target,
            End::Target => End::Source,
        }
    }
}

/// A field of an item type, or a property of an edge type.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypeField {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub required: bool,
    pub description: Option<String>,
    /// The type that declares it: the type itself, or the nearest one it
    /// inherits the field from.
    pub declared_by: String,
    /// The definition whole, as the server answers it.
    pub definition: Value,
}

/// An item type as the copy holds it, its inheritance resolved as
/// `GET /types/{id}` resolves it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemType {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub parent: Option<String>,
    pub version: i64,
    /// By name.
    pub fields: Vec<TypeField>,
    pub title_field: Option<String>,
    pub body_field: Option<String>,
    pub link_field: Option<String>,
    pub roles: Vec<String>,
    pub compatible_with: Vec<String>,
}

/// An edge type as the copy holds it, as `GET /edge-types` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EdgeType {
    pub id: String,
    pub label: Option<String>,
    pub description: Option<String>,
    pub cardinality: String,
    /// The name the edge goes by read from its target.
    pub reverse_name: Option<String>,
    pub written_at: End,
    pub source_type_constraints: Vec<String>,
    pub target_type_constraints: Vec<String>,
    pub cascade_on_delete: String,
    /// By name.
    pub properties: Vec<TypeField>,
    pub shipped: bool,
}

impl EdgeType {
    /// The name a file at `end` writes an edge of this type under, where it
    /// has one.
    pub fn name_at(&self, end: End) -> Option<&str> {
        match end {
            End::Source => Some(&self.id),
            End::Target => self.reverse_name.as_deref(),
        }
    }

    /// Whether an item at `end` holds at most one edge of this type.
    pub fn one_at(&self, end: End) -> bool {
        matches!(
            (end, self.cardinality.as_str()),
            (End::Source, "one-to-one" | "many-to-one")
                | (End::Target, "one-to-one" | "one-to-many")
        )
    }

    #[cfg(test)]
    pub fn of(
        id: &str,
        reverse_name: Option<&str>,
        written_at: End,
        cardinality: &str,
    ) -> EdgeType {
        EdgeType {
            id: id.into(),
            label: None,
            description: None,
            cardinality: cardinality.into(),
            reverse_name: reverse_name.map(str::to_string),
            written_at,
            source_type_constraints: vec!["*".into()],
            target_type_constraints: vec!["*".into()],
            cascade_on_delete: "orphan".into(),
            properties: Vec::new(),
            shipped: false,
        }
    }
}

fn refuse_unless_held(conn: &Connection) -> Result<(), CoreError> {
    if store::catalog_held(conn)? {
        Ok(())
    } else {
        Err(CoreError::NoCatalog)
    }
}

/// The roots a type of the app's own can never be registered under: Marfa's.
const SHIPPED_ROOTS: [&str; 3] = ["core", "system", "marfa"];

/// A type the app declares, read as the server reads a registration: an
/// object naming an identifier outside Marfa's, whose fields each have a type
/// and whose parent is one this copy knows. Answers its id and the JSON it is
/// kept as, with what a registration requires and the app left out filled in.
pub(crate) fn declaration(
    definition: &Value,
    known: &dyn Fn(&str) -> bool,
) -> Result<(String, String), CoreError> {
    let invalid = |message: String| CoreError::Invalid(message);
    let Some(row) = definition.as_object() else {
        return Err(invalid(
            "a type to declare is an object naming its id and its fields".into(),
        ));
    };
    let Some(id) = row.get("id").and_then(Value::as_str) else {
        return Err(invalid("a type to declare names its id".into()));
    };
    let root = id.split('.').next().unwrap_or_default();
    if id.ends_with(".*")
        || !crate::hydrate::type_pattern(id)
        || (root == "app" && id.split('.').count() != 3)
    {
        return Err(invalid(format!(
            "not a type to declare: {id:?}; a type is app.<app-name>.<type>, user.<type>, or <publisher>.<type>, with lowercase dotted segments and at most 128 characters; app names have exactly three segments"
        )));
    }
    if SHIPPED_ROOTS.contains(&root) || crate::builtin::ships(id)? {
        return Err(invalid(format!(
            "{id} is Marfa's, and an app declares types under its own namespace: `app.`, `user.` or a name of its own"
        )));
    }
    if root != "app"
        && root != "user"
        && crate::builtin::reserved_type_roots()?
            .iter()
            .any(|reserved| reserved == root)
    {
        return Err(invalid(format!(
            "not a type to declare: {id:?}; {root} is a reserved type root"
        )));
    }
    let mut row = row.clone();
    match row.get("fields") {
        None => {
            row.insert("fields".into(), Value::Object(Map::new()));
        }
        Some(Value::Object(fields)) => {
            let kinds = crate::builtin::field_types()?;
            for (name, definition) in fields {
                let held =
                    field(name, definition, id).map_err(|error| invalid(error.to_string()))?;
                if !kinds.contains(&held.r#type) {
                    return Err(invalid(format!(
                        "{id} declares {name} as {:?}, which is not a field type: one of {}",
                        held.r#type,
                        kinds.join(", ")
                    )));
                }
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

fn object(id: &str, json: &str) -> Result<Map<String, Value>, CoreError> {
    match serde_json::from_str(json)? {
        Value::Object(row) => Ok(row),
        _ => Err(CoreError::Store(format!(
            "the held type {id} is not an object"
        ))),
    }
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

fn field(name: &str, definition: &Value, declared_by: &str) -> Result<TypeField, CoreError> {
    let Some(kind) = definition.get("type").and_then(Value::as_str) else {
        return Err(CoreError::Decoding(format!(
            "{declared_by} declares {name} with no type"
        )));
    };
    Ok(TypeField {
        name: name.to_string(),
        r#type: kind.to_string(),
        required: definition.get("required").and_then(Value::as_bool) == Some(true),
        description: definition
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        declared_by: declared_by.to_string(),
        definition: definition.clone(),
    })
}

/// The server's resolution of `GET /types/{id}`: fields merged from the root
/// down, the nearer declaration winning, and the hints by the rule every
/// reader of the copy takes them by. The listing already answers `roles`
/// resolved.
fn resolve(
    id: &str,
    held: &HashMap<String, Map<String, Value>>,
    hints: &Catalog,
) -> Result<ItemType, CoreError> {
    let mut chain: Vec<(&str, &Map<String, Value>)> = Vec::new();
    let mut current = Some(id);
    while let Some(at) = current {
        let Some(row) = held.get(at) else { break };
        if chain.len() >= MAX_PARENT_WALK || chain.iter().any(|(seen, _)| *seen == at) {
            return Err(CoreError::Decoding(format!(
                "{id}'s parent chain loops or runs past {MAX_PARENT_WALK} types, so its fields cannot be resolved"
            )));
        }
        chain.push((at, row));
        current = row.get("parent").and_then(Value::as_str);
    }
    let Some((_, own)) = chain.first().copied() else {
        return Err(type_not_found(id));
    };
    let mut fields: BTreeMap<String, TypeField> = BTreeMap::new();
    for (declaring, row) in chain.iter().rev() {
        if let Some(declared) = row.get("fields").and_then(Value::as_object) {
            for (name, definition) in declared {
                fields.insert(name.clone(), field(name, definition, declaring)?);
            }
        }
    }
    Ok(ItemType {
        id: id.to_string(),
        label: text(own, "label"),
        description: text(own, "description"),
        parent: text(own, "parent"),
        version: own.get("version").and_then(Value::as_f64).unwrap_or(0.0) as i64,
        fields: fields.into_values().collect(),
        title_field: hints.title_field(id).map(str::to_string),
        body_field: hints.body_field(id).map(str::to_string),
        link_field: text(own, "link_field"),
        roles: texts(own, "roles"),
        compatible_with: texts(own, "compatible_with"),
    })
}

fn type_not_found(id: &str) -> CoreError {
    CoreError::NotFound {
        code: "type_not_found".into(),
        message: format!("the catalog this copy holds has no type {id}"),
    }
}

fn held_types(conn: &Connection) -> Result<HashMap<String, Map<String, Value>>, CoreError> {
    refuse_unless_held(conn)?;
    store::type_rows(conn)?
        .into_iter()
        .map(|(id, json)| object(&id, &json).map(|row| (id, row)))
        .collect()
}

/// By id.
pub fn item_types(conn: &Connection) -> Result<Vec<ItemType>, CoreError> {
    store::catalog_scope(conn, |conn| {
        let held = held_types(conn)?;
        let hints = Catalog::load(conn)?;
        let mut ids: Vec<&String> = held.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| resolve(id, &held, &hints))
            .collect()
    })
}

pub fn item_type(conn: &Connection, id: &str) -> Result<ItemType, CoreError> {
    store::catalog_scope(conn, |conn| {
        resolve(id, &held_types(conn)?, &Catalog::load(conn)?)
    })
}

fn edge_type_of(id: &str, json: &str) -> Result<EdgeType, CoreError> {
    let wire: WireEdgeType = serde_json::from_str(json)
        .map_err(|error| CoreError::Store(format!("the held edge type {id}: {error}")))?;
    let properties = wire
        .property_schema
        .iter()
        .map(|(name, definition)| field(name, definition, &wire.id))
        .collect::<Result<_, _>>()?;
    Ok(EdgeType {
        id: wire.id,
        label: wire.label,
        description: wire.description,
        cardinality: wire.cardinality,
        reverse_name: wire.reverse_name,
        written_at: wire.written_at,
        source_type_constraints: wire.source_type_constraints,
        target_type_constraints: wire.target_type_constraints,
        cascade_on_delete: wire.cascade_on_delete,
        properties,
        shipped: wire.shipped,
    })
}

/// By id.
pub fn edge_types(conn: &Connection) -> Result<Vec<EdgeType>, CoreError> {
    store::catalog_scope(conn, |conn| {
        refuse_unless_held(conn)?;
        store::edge_type_rows(conn)?
            .iter()
            .map(|(id, json)| edge_type_of(id, json))
            .collect()
    })
}

pub fn edge_type(conn: &Connection, id: &str) -> Result<EdgeType, CoreError> {
    store::catalog_scope(conn, |conn| {
        refuse_unless_held(conn)?;
        match store::edge_type_rows(conn)?
            .into_iter()
            .find(|(held, _)| held == id)
        {
            Some((id, json)) => edge_type_of(&id, &json),
            None => Err(CoreError::NotFound {
                code: "edge_type_not_found".into(),
                message: format!("the catalog this copy holds has no edge type {id}"),
            }),
        }
    })
}

/// The four properties search reads whether or not a type declares them,
/// as the server's index does. A thumbnail may not take one of these names.
pub const CORE_TEXT_FIELDS: [&str; 4] = ["title", "body", "description", "name"];

/// What the local index reads from an item's properties: the server's rule,
/// which `search-and-filters.md` states.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Indexing {
    /// Core properties the type declares as strings and marks
    /// `searchable: false`.
    pub opted_out: Vec<String>,
    /// The string properties the type declares or inherits beyond the core
    /// four, not marked `searchable: false`, in name order.
    pub extra: Vec<String>,
}

/// The server's type catalog as last hydrated, answering the same subtree
/// question `?type=` answers on the server: exact name, dotted-name
/// descendant, or a type whose declared parent chain reaches the root.
pub struct Catalog {
    entries: HashMap<String, Entry>,
}

const MAX_PARENT_WALK: usize = 64;

impl Catalog {
    pub fn load(conn: &Connection) -> Result<Catalog, CoreError> {
        let mut statement = conn.prepare(
            "SELECT id, parent, title_field, thumbnail_field,
                    json_extract(json, '$.display_hints.body_field'),
                    json_extract(json, '$.fields'),
                    json_type(json, '$.display_hints') IS NOT NULL
               FROM types",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })?;
        let mut entries = HashMap::new();
        for row in rows {
            let (id, parent, title_field, thumbnail_field, body_field, fields, hinted) = row?;
            let fields: Map<String, Value> = fields
                .map(|fields| serde_json::from_str(&fields))
                .transpose()?
                .unwrap_or_default();
            entries.insert(
                id,
                Entry {
                    parent,
                    hinted,
                    title_field,
                    thumbnail_field,
                    body_field,
                    fields: fields.keys().cloned().collect(),
                    definitions: fields,
                },
            );
        }
        Ok(Catalog { entries })
    }

    pub(crate) fn validate_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        complete: bool,
    ) -> Result<(), CoreError> {
        if !self.known(type_id) {
            return Err(CoreError::UnknownType {
                message: format!("{type_id} is not a type this copy holds"),
            });
        }
        let mut chain = Vec::new();
        let mut current = Some(type_id);
        while let Some(at) = current {
            let Some(entry) = self.entries.get(at) else {
                break;
            };
            if chain.len() >= MAX_PARENT_WALK || chain.iter().any(|(seen, _)| *seen == at) {
                return Err(CoreError::Decoding(format!(
                    "{type_id}'s fields cannot be resolved because its parent chain loops or runs past {MAX_PARENT_WALK} types"
                )));
            }
            chain.push((at, entry));
            current = entry.parent.as_deref();
        }
        let mut fields = BTreeMap::new();
        for (_, entry) in chain.into_iter().rev() {
            for (name, definition) in &entry.definitions {
                fields.insert(name.as_str(), definition);
            }
        }
        crate::validation::properties(&fields, properties, complete)
    }

    /// A create's properties as the server holds them: a null on a field
    /// the type declares and does not require is dropped, and one on a
    /// property it does not declare is kept (`items.md` 68).
    pub(crate) fn created_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Map<String, Value> {
        properties
            .iter()
            .filter(|(name, value)| {
                !value.is_null()
                    || match self.definition(type_id, name) {
                        Some(definition) => Self::required(definition),
                        None => !EVERY_TYPE_TAKES.contains(&name.as_str()),
                    }
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }

    /// The nearest declaration of `name` in the type's chain.
    fn definition(&self, type_id: &str, name: &str) -> Option<&Value> {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let entry = self.entries.get(current)?;
            if let Some(definition) = entry.definitions.get(name) {
                return Some(definition);
            }
            current = entry.parent.as_deref()?;
        }
        None
    }

    fn required(definition: &Value) -> bool {
        definition.get("required").and_then(Value::as_bool) == Some(true)
    }

    /// Match the server's null rule in the local projection; the queued
    /// request stays unchanged so the server validates what the caller sent.
    pub fn projected_properties(
        &self,
        type_id: &str,
        properties: &Map<String, Value>,
        replace: bool,
    ) -> Map<String, Value> {
        properties
            .iter()
            .filter(|(name, value)| {
                if !value.is_null() {
                    return true;
                }
                if replace {
                    return false;
                }
                if !self.known(type_id) {
                    return true;
                }
                let mut current = type_id;
                for _ in 0..MAX_PARENT_WALK {
                    let Some(entry) = self.entries.get(current) else {
                        break;
                    };
                    if let Some(definition) = entry.definitions.get(*name) {
                        return definition.get("required").and_then(Value::as_bool) == Some(true);
                    }
                    let Some(parent) = entry.parent.as_deref() else {
                        break;
                    };
                    current = parent;
                }
                false
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect()
    }

    /// A create's properties in the order the server answers them
    /// (`items.md` 46): the fields the type declares, in the order a read of
    /// the type lists them, its parent's before its own and a field declared
    /// again keeping the place it first took, then the rest as given.
    pub(crate) fn in_answer_order(
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

    /// A create of a type the catalog does not know is refused `400 unknown_type`
    /// by the server, after the caller was told it was queued, so it is checked
    /// here first.
    pub fn known(&self, type_id: &str) -> bool {
        self.entries.contains_key(type_id)
    }

    /// From the hints of the nearest type that declares any, taken whole as
    /// `GET /types/{id}` resolves them: a subtype naming only its body
    /// inherits no title.
    pub fn title_field(&self, type_id: &str) -> Option<&str> {
        self.hints(type_id)?.title_field.as_deref()
    }

    /// The property a type's text lives in, from the same hints as its title.
    pub fn body_field(&self, type_id: &str) -> Option<&str> {
        self.hints(type_id)?.body_field.as_deref()
    }

    /// The property an item of the type is titled by: its hints' title field,
    /// or `title` where they name none (`folders.md` 7).
    pub fn title_property(&self, type_id: &str) -> &str {
        self.title_field(type_id).unwrap_or(TITLE_PROPERTY)
    }

    /// The property an item of the type keeps its text in: its hints' body
    /// field, or `body` where they name none (`folders.md` 7).
    pub fn body_property(&self, type_id: &str) -> &str {
        self.body_field(type_id).unwrap_or(BODY_PROPERTY)
    }

    /// The text an item holds under its type's title and body properties; a
    /// value that is not a string shows as none.
    pub fn shown(&self, item: &Item) -> Shown {
        let text = |property: &str| {
            item.properties
                .get(property)
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        Shown {
            title: text(self.title_property(&item.r#type)),
            body: text(self.body_property(&item.r#type)),
        }
    }

    fn hints(&self, type_id: &str) -> Option<&Entry> {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let entry = self.entries.get(current)?;
            if entry.hinted {
                return Some(entry);
            }
            current = entry.parent.as_deref()?;
        }
        None
    }

    /// Every type the copy holds, with the properties each declares itself.
    pub fn declared(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.entries
            .iter()
            .map(|(id, entry)| (id.as_str(), entry.fields.as_slice()))
    }

    /// The thumbnail a type carries, its own or the one it inherits: the
    /// server's `GET /types` answers each type as declared, not resolved.
    pub fn thumbnail_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.thumbnail_field.as_deref())
    }

    /// A type the catalog does not hold, or one whose parent it does not,
    /// resolves as far as the catalog reaches: a row of an unknown type
    /// contributes its core properties alone.
    pub fn indexing(&self, type_id: &str) -> Indexing {
        let mut chain: Vec<&Entry> = Vec::new();
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
        // In name order, the server's: a phrase that crosses two fields
        // then matches on both or on neither.
        indexing.extra.sort();
        indexing
    }

    fn nearest<'a>(
        &'a self,
        type_id: &str,
        read: impl Fn(&'a Entry) -> Option<&'a str>,
    ) -> Option<&'a str> {
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

    fn catalog(pairs: &[(&str, Option<&str>)]) -> Catalog {
        Catalog {
            entries: pairs
                .iter()
                .map(|(id, parent)| {
                    (
                        id.to_string(),
                        Entry {
                            parent: parent.map(str::to_string),
                            hinted: false,
                            title_field: None,
                            thumbnail_field: None,
                            body_field: None,
                            fields: Vec::new(),
                            definitions: Map::new(),
                        },
                    )
                })
                .collect(),
        }
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

    fn held(types: serde_json::Value, edge_types: serde_json::Value) -> Connection {
        let conn = store::open_in_memory().unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(types).unwrap(),
            edge_types: serde_json::from_value(edge_types).unwrap(),
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        conn
    }

    #[test]
    fn a_type_is_read_with_its_fields_resolved_as_the_server_resolves_them() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.base", "label": "Base",
                  "fields": { "name": { "type": "string", "required": true },
                              "note": { "type": "string" } },
                  "display_hints": { "title_field": "name", "body_field": "note" } },
                { "id": "acme.mid", "parent": "acme.base",
                  "fields": { "name": { "type": "string", "required": true, "description": "again" } },
                  "display_hints": { "title_field": "name" } },
                { "id": "acme.leaf", "parent": "acme.mid", "label": "Leaf",
                  "fields": { "stars": { "type": "number" } } }
            ]),
            serde_json::json!([]),
        );
        let leaf = item_type(&conn, "acme.leaf").unwrap();
        let declared: Vec<(&str, &str)> = leaf
            .fields
            .iter()
            .map(|field| (field.name.as_str(), field.declared_by.as_str()))
            .collect();
        assert_eq!(
            declared,
            [
                ("name", "acme.mid"),
                ("note", "acme.base"),
                ("stars", "acme.leaf")
            ],
            "a field declared again nearer the type did not take the place of the one above it"
        );
        assert_eq!(leaf.fields[0].description.as_deref(), Some("again"));
        assert_eq!(
            (leaf.title_field.as_deref(), leaf.body_field),
            (Some("name"), None),
            "the hints were merged field by field, where the server takes the nearest block whole"
        );
        assert_eq!(leaf.label.as_deref(), Some("Leaf"));
        assert_eq!(leaf.parent.as_deref(), Some("acme.mid"));
        assert_eq!(item_types(&conn).unwrap().len(), 3);
    }

    #[test]
    fn every_reader_takes_the_nearest_hints_whole() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.base", "fields": { "name": { "type": "string" } },
                  "display_hints": { "title_field": "name", "body_field": "text" } },
                { "id": "acme.leaf", "parent": "acme.base",
                  "fields": { "comment": { "type": "string" } },
                  "display_hints": { "body_field": "comment" } },
                { "id": "acme.bare", "parent": "acme.base", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        let catalog = Catalog::load(&conn).unwrap();
        assert_eq!(
            (
                catalog.title_field("acme.leaf"),
                catalog.body_field("acme.leaf")
            ),
            (None, Some("comment")),
            "a subtype naming only its body took its title from its parent's hints"
        );
        // The witness: a subtype with no hints of its own takes its parent's.
        assert_eq!(catalog.title_field("acme.bare"), Some("name"));
        let leaf = item_type(&conn, "acme.leaf").unwrap();
        assert_eq!(
            (leaf.title_field, leaf.body_field.as_deref()),
            (None, Some("comment"))
        );
    }

    #[test]
    fn an_item_shows_the_title_and_body_its_types_hints_name() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.event", "fields": { "title": { "type": "string" },
                                                   "description": { "type": "string" } },
                  "display_hints": { "title_field": "title", "body_field": "description" } },
                { "id": "acme.event.session", "parent": "acme.event",
                  "fields": { "transcript": { "type": "string" } },
                  "display_hints": { "title_field": "title", "body_field": "transcript" } },
                { "id": "acme.event.call", "parent": "acme.event", "fields": {} },
                { "id": "acme.event.memo", "parent": "acme.event",
                  "fields": { "text": { "type": "string" } },
                  "display_hints": { "body_field": "text" } },
                { "id": "acme.person", "fields": { "name": { "type": "string" } },
                  "display_hints": { "title_field": "name" } },
                { "id": "acme.plain", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        let catalog = Catalog::load(&conn).unwrap();
        let item = |r#type: &str, properties: serde_json::Value| Item {
            id: "i".into(),
            r#type: r#type.into(),
            properties: serde_json::from_value(properties).unwrap(),
            state: crate::model::ItemState::Active,
            tier: None,
            version: 1,
            schema_version: 0,
            source: "s".into(),
            source_id: None,
            occurred_at: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            tags: Vec::new(),
        };
        let shown = |r#type: &str, properties: serde_json::Value| {
            let shown = catalog.shown(&item(r#type, properties));
            (shown.title, shown.body)
        };
        let text = |value: &str| Some(value.to_string());
        let every = serde_json::json!({
            "title": "T", "body": "B", "description": "D", "transcript": "S",
            "text": "X", "name": "N"
        });
        assert_eq!(shown("acme.event", every.clone()), (text("T"), text("D")));
        assert_eq!(
            shown("acme.event.session", every.clone()),
            (text("T"), text("S")),
            "a subtype's own body field lost to its parent's"
        );
        assert_eq!(
            shown("acme.event.call", every.clone()),
            (text("T"), text("D")),
            "a subtype with no hints of its own did not take its parent's"
        );
        assert_eq!(
            shown("acme.event.memo", every.clone()),
            (text("T"), text("X")),
            "a subtype naming only its body did not fall back to `title`"
        );
        assert_eq!(shown("acme.person", every.clone()), (text("N"), text("B")));
        assert_eq!(shown("acme.plain", every.clone()), (text("T"), text("B")));
        assert_eq!(
            shown("acme.unheld", every),
            (text("T"), text("B")),
            "a type the catalog does not hold took no fallback"
        );
        assert_eq!(
            shown(
                "acme.person",
                serde_json::json!({ "name": 3, "body": ["B"] })
            ),
            (None, None),
            "a value that is not text was shown as text"
        );
    }

    #[test]
    fn a_create_is_held_in_the_order_the_server_answers_it() {
        // The server answers this create `zeta, alpha, mid, beta, extra1,
        // extra0`.
        let conn = held(
            serde_json::json!([
                { "id": "acme.parent",
                  "fields": { "zeta": { "type": "string" }, "alpha": { "type": "string" } } },
                { "id": "acme.child", "parent": "acme.parent",
                  "fields": { "mid": { "type": "string" }, "beta": { "type": "string" },
                              "alpha": { "type": "string", "description": "again" } } }
            ]),
            serde_json::json!([]),
        );
        let catalog = Catalog::load(&conn).unwrap();
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
    fn a_create_holds_its_nulls_as_the_server_does() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.base",
                  "fields": { "title": { "type": "string" },
                              "body": { "type": "string", "required": true } } },
                { "id": "acme.leaf", "parent": "acme.base", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        let catalog = Catalog::load(&conn).unwrap();
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
    fn indexing_resolves_declared_string_fields_through_the_parents() {
        let conn = held(
            serde_json::json!([
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
            ]),
            serde_json::json!([]),
        );
        let catalog = Catalog::load(&conn).unwrap();
        assert_eq!(
            catalog.indexing("acme.base"),
            Indexing {
                opted_out: vec!["title".into()],
                extra: vec!["blurb".into()],
            }
        );
        // The nearer declaration replaces the farther and keeps its place:
        // `secret` is searchable again, `blurb` is not, and the display hint
        // that named `blurb` the title changes nothing.
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
    fn public_item_type_reads_keep_fields_and_hints_in_one_snapshot() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        for single in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("core.sqlite");
            let writing = store::open(&path).unwrap();
            let catalog = |field: &str| crate::wire::WireCatalog {
                types: serde_json::from_value(serde_json::json!([{
                    "id": "acme.note", "fields": {field: {"type": "string"}},
                    "display_hints": {"title_field": field}
                }]))
                .unwrap(),
                edge_types: Vec::new(),
            };
            store::replace_catalog(&writing, &catalog("old")).unwrap();
            let reading = crate::Core::open_reader(&path).unwrap();
            let changed = Arc::new(AtomicBool::new(false));
            let witnessed = changed.clone();
            reading
                .conn()
                .unwrap()
                .authorizer(Some(move |ctx: AuthContext<'_>| {
                    // The fields have been read; hints are a separate statement.
                    if matches!(
                        ctx.action,
                        AuthAction::Read {
                            table_name: "types",
                            column_name: "parent"
                        }
                    ) && !witnessed.swap(true, Ordering::SeqCst)
                    {
                        store::replace_catalog(&writing, &catalog("new")).unwrap();
                    }
                    Authorization::Allow
                }))
                .unwrap();
            let old = if single {
                reading.item_type("acme.note").unwrap()
            } else {
                reading.item_types().unwrap().remove(0)
            };
            assert!(
                changed.load(Ordering::SeqCst),
                "the concurrent refresh did not run"
            );
            assert_eq!(old.fields[0].name, "old");
            assert_eq!(old.title_field.as_deref(), Some("old"));
            let new = reading.item_type("acme.note").unwrap();
            assert_eq!(new.fields[0].name, "new");
            assert_eq!(new.title_field.as_deref(), Some("new"));
        }
    }

    #[test]
    fn public_catalog_reads_nest_without_finishing_the_callers_transaction() {
        let core = crate::Core::open_in_memory(None).unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.note", "fields": {} }]))
                .unwrap(),
            edge_types: vec![
                serde_json::json!({ "id": "references", "cardinality": "many-to-many", "source_type_constraints": ["*"], "target_type_constraints": ["*"], "cascade_on_delete": "orphan", "property_schema": {}, "shipped": true, "written_at": "source" }),
            ],
        };
        {
            let conn = core.conn().unwrap();
            store::replace_catalog(&conn, &catalog).unwrap();
            conn.execute_batch("BEGIN; INSERT INTO meta(key, value) VALUES ('caller', 'kept')")
                .unwrap();
        }
        assert_eq!(core.item_types().unwrap()[0].id, "acme.note");
        assert_eq!(core.item_type("acme.note").unwrap().id, "acme.note");
        assert_eq!(core.edge_types().unwrap()[0].id, "references");
        assert_eq!(core.edge_type("references").unwrap().id, "references");
        assert!(matches!(
            core.item_type("missing"),
            Err(CoreError::NotFound { .. })
        ));
        assert!(matches!(
            core.edge_type("missing"),
            Err(CoreError::NotFound { .. })
        ));
        let conn = core.conn().unwrap();
        assert!(
            !conn.is_autocommit(),
            "a nested read ended its caller's transaction"
        );
        assert_eq!(
            store::meta_get(&conn, "caller").unwrap().as_deref(),
            Some("kept")
        );
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(store::meta_get(&conn, "caller").unwrap(), None);
        drop(conn);
        assert_eq!(core.item_types().unwrap()[0].id, "acme.note");
    }

    #[test]
    fn a_catalog_that_cannot_be_written_whole_writes_nothing() {
        let conn = store::open_in_memory().unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.base" }])).unwrap(),
            edge_types: vec![serde_json::json!({ "cardinality": "many-to-many" })],
        };
        assert!(store::replace_catalog(&conn, &catalog).is_err());
        assert_eq!(store::catalog_version(&conn).unwrap(), None);
        assert!(
            store::type_rows(&conn).unwrap().is_empty(),
            "the item types were written though the edge types were refused"
        );
    }

    #[test]
    fn a_failed_catalog_rollback_reports_both_errors_without_committing_partial_writes() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
        let conn = held(
            serde_json::json!([{ "id": "acme.old" }]),
            serde_json::json!([]),
        );
        conn.execute_batch("BEGIN; INSERT INTO meta(key, value) VALUES ('caller', 'kept')")
            .unwrap();
        conn.authorizer(Some(|ctx: AuthContext<'_>| {
            if matches!(
                ctx.action,
                AuthAction::Savepoint {
                    operation: TransactionOperation::Rollback,
                    ..
                }
            ) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.partial" }])).unwrap(),
            edge_types: vec![serde_json::json!({ "cardinality": "many-to-many" })],
        };
        let error = store::replace_catalog(&conn, &catalog)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("id"),
            "the original catalog error was lost: {error}"
        );
        assert!(
            error.contains("rollback"),
            "the rollback failure was hidden: {error}"
        );
        assert!(
            !conn.is_autocommit(),
            "cleanup committed or discarded the caller's transaction"
        );
        assert_eq!(
            store::meta_get(&conn, "caller").unwrap().as_deref(),
            Some("kept")
        );
        assert_eq!(
            store::type_rows(&conn).unwrap()[0].0,
            "acme.partial",
            "the failing operation made no partial write to protect"
        );
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
        assert_eq!(store::meta_get(&conn, "caller").unwrap(), None);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn a_failed_catalog_write_rolls_back_only_its_scope() {
        for fail_release in [false, true] {
            use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
            let conn = held(
                serde_json::json!([{ "id": "acme.old" }]),
                serde_json::json!([]),
            );
            conn.execute_batch("BEGIN; INSERT INTO meta(key, value) VALUES ('caller', 'kept')")
                .unwrap();
            let opened = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let captured = opened.clone();
            let mut denied = false;
            conn.authorizer(Some(move |ctx: AuthContext<'_>| {
                if let AuthAction::Savepoint {
                    operation: TransactionOperation::Begin,
                    savepoint_name,
                } = ctx.action
                {
                    *captured.lock().unwrap() = savepoint_name.to_string();
                }
                if fail_release
                    && !denied
                    && matches!(
                        ctx.action,
                        AuthAction::Savepoint {
                            operation: TransactionOperation::Release,
                            ..
                        }
                    )
                {
                    denied = true;
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))
            .unwrap();
            let catalog = crate::wire::WireCatalog {
                types: serde_json::from_value(serde_json::json!([{ "id": "acme.new" }])).unwrap(),
                edge_types: if fail_release {
                    Vec::new()
                } else {
                    vec![serde_json::json!({ "cardinality": "many-to-many" })]
                },
            };
            assert!(store::replace_catalog(&conn, &catalog).is_err());
            assert!(!conn.is_autocommit());
            assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
            assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
            assert_eq!(
                store::meta_get(&conn, "caller").unwrap().as_deref(),
                Some("kept")
            );
            assert!(
                conn.execute_batch(&format!("RELEASE {}", opened.lock().unwrap()))
                    .is_err(),
                "cleanup left the catalog savepoint open"
            );
            conn.execute_batch("COMMIT").unwrap();
            assert_eq!(
                store::meta_get(&conn, "caller").unwrap().as_deref(),
                Some("kept")
            );
            assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
        }
    }

    #[test]
    fn a_transient_catalog_rollback_error_is_reported_and_cleanup_is_retried() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
        let conn = held(
            serde_json::json!([{ "id": "acme.old" }]),
            serde_json::json!([]),
        );
        let mut denied = false;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            if !denied
                && matches!(
                    ctx.action,
                    AuthAction::Savepoint {
                        operation: TransactionOperation::Rollback,
                        ..
                    }
                )
            {
                denied = true;
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.partial" }])).unwrap(),
            edge_types: vec![serde_json::json!({ "cardinality": "many-to-many" })],
        };
        let error = store::replace_catalog(&conn, &catalog)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("id") && error.contains("rollback"),
            "{error}"
        );
        assert!(conn.is_autocommit(), "the retry left a savepoint open");
        assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
    }

    #[test]
    fn an_automatic_catalog_rollback_reports_the_original_failure() {
        let conn = held(
            serde_json::json!([{ "id": "acme.old" }]),
            serde_json::json!([]),
        );
        conn.execute_batch("CREATE TEMP TRIGGER abort_catalog BEFORE INSERT ON edge_types BEGIN SELECT RAISE(ROLLBACK, 'catalog aborted'); END;").unwrap();
        let catalog = crate::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.partial" }])).unwrap(),
            edge_types: vec![serde_json::json!({ "id": "references" })],
        };
        let error = store::replace_catalog(&conn, &catalog)
            .unwrap_err()
            .to_string();
        assert!(error.contains("catalog aborted"), "{error}");
        assert!(!error.contains("no such savepoint"), "{error}");
        assert!(conn.is_autocommit());
        assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
    }

    #[test]
    fn an_outer_catalog_scope_cleans_up_its_failed_nested_scope() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
        let conn = held(
            serde_json::json!([{ "id": "acme.old" }]),
            serde_json::json!([]),
        );
        let mut refused = 0;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            if matches!(
                ctx.action,
                AuthAction::Savepoint {
                    operation: TransactionOperation::Rollback,
                    ..
                }
            ) && refused < 2
            {
                refused += 1;
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
        let result = store::catalog_scope(&conn, |conn| {
            store::meta_set(conn, "outer_scope", "uncommitted")?;
            store::replace_catalog(
                conn,
                &crate::wire::WireCatalog {
                    types: serde_json::from_value(serde_json::json!([{ "id": "acme.partial" }]))
                        .unwrap(),
                    edge_types: vec![serde_json::json!({ "cardinality": "many-to-many" })],
                },
            )
        });
        assert!(result.is_err());
        assert!(
            conn.is_autocommit(),
            "cleanup released the failed inner scope instead of its own"
        );
        assert_eq!(store::meta_get(&conn, "outer_scope").unwrap(), None);
        assert_eq!(store::type_rows(&conn).unwrap()[0].0, "acme.old");
    }

    #[test]
    fn a_type_whose_parents_loop_is_refused_rather_than_resolved() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.a", "parent": "acme.b", "fields": {} },
                { "id": "acme.b", "parent": "acme.a", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        assert!(matches!(
            item_type(&conn, "acme.a"),
            Err(CoreError::Decoding(_))
        ));
    }

    #[test]
    fn a_copy_with_no_catalog_refuses_rather_than_answering_none() {
        let conn = store::open_in_memory().unwrap();
        assert_eq!(item_types(&conn), Err(CoreError::NoCatalog));
        assert_eq!(edge_types(&conn), Err(CoreError::NoCatalog));
        assert_eq!(store::catalog_version(&conn).unwrap(), None);
        // The witness: an instance with no edge types is a catalog, and answers.
        let conn = held(serde_json::json!([]), serde_json::json!([]));
        assert_eq!(edge_types(&conn), Ok(Vec::new()));
        assert!(matches!(
            item_type(&conn, "acme.absent"),
            Err(CoreError::NotFound { code, .. }) if code == "type_not_found"
        ));
    }

    #[test]
    fn the_version_moves_when_either_catalog_changes_and_only_then() {
        let conn = store::open_in_memory().unwrap();
        let catalog = |reverse: &str| crate::wire::WireCatalog {
            types: Vec::new(),
            edge_types: vec![serde_json::json!({
                "id": "mentor-of", "cardinality": "one-to-many",
                "source_type_constraints": ["*"], "target_type_constraints": ["*"],
                "cascade_on_delete": "orphan", "property_schema": {},
                "reverse_name": reverse, "written_at": "target", "shipped": false
            })],
        };
        assert!(store::replace_catalog(&conn, &catalog("mentored-by")).unwrap());
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
        assert!(!store::replace_catalog(&conn, &catalog("mentored-by")).unwrap());
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
        assert!(store::replace_catalog(&conn, &catalog("taught-by")).unwrap());
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(2));
        let mentor = edge_type(&conn, "mentor-of").unwrap();
        assert_eq!(
            (mentor.reverse_name.as_deref(), mentor.written_at),
            (Some("taught-by"), End::Target)
        );
    }

    #[test]
    fn a_parent_cycle_ends() {
        let catalog = catalog(&[("a", Some("b")), ("b", Some("a"))]);
        assert!(!catalog.matches("z", "a"));
    }
}
