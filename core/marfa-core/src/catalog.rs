use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::store;
use crate::wire::WireEdgeType;

struct Entry {
    parent: Option<String>,
    /// Whether the type declares a `display_hints` block of its own.
    hinted: bool,
    title_field: Option<String>,
    thumbnail_field: Option<String>,
    body_field: Option<String>,
    /// The properties the type declares itself, not those it inherits.
    fields: Vec<String>,
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
    match store::catalog_version(conn)? {
        Some(_) => Ok(()),
        None => Err(CoreError::NoCatalog),
    }
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
    let held = held_types(conn)?;
    let hints = Catalog::load(conn)?;
    let mut ids: Vec<&String> = held.keys().collect();
    ids.sort();
    ids.into_iter()
        .map(|id| resolve(id, &held, &hints))
        .collect()
}

pub fn item_type(conn: &Connection, id: &str) -> Result<ItemType, CoreError> {
    resolve(id, &held_types(conn)?, &Catalog::load(conn)?)
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
    refuse_unless_held(conn)?;
    store::edge_type_rows(conn)?
        .iter()
        .map(|(id, json)| edge_type_of(id, json))
        .collect()
}

pub fn edge_type(conn: &Connection, id: &str) -> Result<EdgeType, CoreError> {
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
}

/// What the local index reads from an item's properties.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Indexing {
    pub title_field: Option<String>,
    /// Never indexed: its base64 matches nothing a person would search for,
    /// and the server leaves it out of its own index too.
    pub thumbnail_field: Option<String>,
}

#[cfg(test)]
impl Indexing {
    pub fn titled(field: &str) -> Indexing {
        Indexing {
            title_field: Some(field.to_string()),
            thumbnail_field: None,
        }
    }
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
                    (SELECT json_group_array(key) FROM json_each(types.json, '$.fields')),
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
            entries.insert(
                id,
                Entry {
                    parent,
                    hinted,
                    title_field,
                    thumbnail_field,
                    body_field,
                    fields: fields
                        .and_then(|fields| serde_json::from_str(&fields).ok())
                        .unwrap_or_default(),
                },
            );
        }
        Ok(Catalog { entries })
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

    pub fn indexing(&self, type_id: &str) -> Indexing {
        Indexing {
            title_field: self.title_field(type_id).map(str::to_string),
            thumbnail_field: self.thumbnail_field(type_id).map(str::to_string),
        }
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
                        },
                    )
                })
                .collect(),
        }
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
        assert_eq!(catalog.indexing("acme.leaf").title_field, None);
        // The witness: a subtype with no hints of its own takes its parent's.
        assert_eq!(catalog.title_field("acme.bare"), Some("name"));
        let leaf = item_type(&conn, "acme.leaf").unwrap();
        assert_eq!(
            (leaf.title_field, leaf.body_field.as_deref()),
            (None, Some("comment"))
        );
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
