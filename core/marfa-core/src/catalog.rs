use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{Item, Shown};
use crate::store;
use crate::store::Unreadable;
use marfa_rules::catalog::{
    Catalog, CatalogEntry, EdgeType, ItemType, Lineage, lineage_of, resolve_item_type,
};
use marfa_rules::display::ItemDisplay;
use marfa_rules::wire::{WireCatalog, WireEdgeType};

/// A server's two catalogs as it lists them now, each type resolved as the
/// copy's own reads resolve it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerCatalog {
    /// By id.
    pub item_types: Vec<ItemType>,
    /// By id.
    pub edge_types: Vec<EdgeType>,
}

/// Held in a store of its own, so the reads that answer for the copy's
/// catalog answer for this one, and the copy's is left as it was.
pub(crate) fn served(listed: &WireCatalog) -> Result<ServerCatalog, CoreError> {
    let conn = store::open_in_memory()?;
    store::replace_catalog(&conn, listed)?;
    Ok(ServerCatalog {
        item_types: item_types(&conn)?,
        edge_types: edge_types(&conn)?,
    })
}

fn refuse_unless_held(conn: &Connection) -> Result<(), CoreError> {
    if store::catalog_held(conn)? {
        Ok(())
    } else {
        Err(CoreError::NoCatalog)
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

fn type_not_found(id: &str) -> CoreError {
    CoreError::NotFound {
        status: None,
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

/// `None` for a type the copy does not hold, or where it holds no catalog.
pub(crate) fn lineage(conn: &Connection, id: &str) -> Result<Option<Lineage>, CoreError> {
    if !store::catalog_held(conn)? {
        return Ok(None);
    }
    Ok(lineage_of(&held_types(conn)?, id))
}

fn resolved(
    id: &str,
    held: &HashMap<String, Map<String, Value>>,
    hints: &Catalog,
) -> Result<ItemType, CoreError> {
    resolve_item_type(id, held, hints)?.ok_or_else(|| type_not_found(id))
}

/// By id.
pub fn item_types(conn: &Connection) -> Result<Vec<ItemType>, CoreError> {
    store::catalog_scope(conn, |conn| {
        let held = held_types(conn)?;
        let hints = load(conn)?;
        let mut ids: Vec<&String> = held.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| resolved(id, &held, &hints))
            .collect()
    })
}

pub fn item_type(conn: &Connection, id: &str) -> Result<ItemType, CoreError> {
    store::catalog_scope(conn, |conn| resolved(id, &held_types(conn)?, &load(conn)?))
}

/// An item's tables: its type chain's and, from `core.table` down, its own.
pub(crate) fn item_tables(
    conn: &Connection,
    type_id: &str,
    properties: &Map<String, Value>,
) -> Result<Map<String, Value>, CoreError> {
    store::catalog_scope(conn, |conn| {
        let registry = marfa_rules::schema::Registry::new(held_types(conn)?.into_values());
        marfa_rules::schema::item_tables(&registry, type_id, properties)
            .map_err(|_| type_not_found(type_id))
    })
}

fn edge_type_of(id: &str, json: &str) -> Result<EdgeType, CoreError> {
    let wire: WireEdgeType = serde_json::from_str(json)
        .map_err(|error| CoreError::Store(format!("the held edge type {id}: {error}")))?;
    Ok(EdgeType::from_wire(wire)?)
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
                status: None,
                code: "edge_type_not_found".into(),
                message: format!("the catalog this copy holds has no edge type {id}"),
            }),
        }
    })
}

/// The catalog the copy holds, with the request limit the server last said.
pub fn load(conn: &Connection) -> Result<Catalog, CoreError> {
    let mut statement = conn.prepare(
        "SELECT id, parent, title_field, thumbnail_field,
                json_extract(json, '$.display_hints.body_field'),
                json_extract(json, '$.fields'),
                json_extract(json, '$.display_hints.icon'),
                json_extract(json, '$.display_hints.name_from_body')
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
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<bool>>(7)?,
        ))
    })?;
    let mut entries = HashMap::new();
    for row in rows {
        let (id, parent, title_field, thumbnail_field, body_field, fields, icon, name_from_body) =
            row?;
        let definitions: Map<String, Value> = fields
            .map(|fields| serde_json::from_str(&fields))
            .transpose()?
            .unwrap_or_default();
        entries.insert(
            id,
            CatalogEntry {
                parent,
                title_field,
                thumbnail_field,
                body_field,
                name_from_body,
                icon,
                fields: definitions.keys().cloned().collect(),
                definitions,
            },
        );
    }
    Ok(Catalog::new(entries, crate::store::request_limit(conn)?))
}

/// What only a working copy can say of a catalog: its words as an item shows
/// them, read from the copy's own rows, and the request limit a write is held
/// to.
pub trait CatalogExt {
    /// The text an item holds under its type's title and body properties; a
    /// value that is not a string shows as none.
    fn shown(&self, item: &Item) -> Shown;

    /// `shown`, naming why the properties are empty where the read kept a
    /// row whose stored properties it could not read.
    fn shown_unreadable(&self, item: &Item, unreadable: &Unreadable) -> Shown;

    /// The name and preview of the item `id`, a part or an excerpt named
    /// after its host where `types/item-name-part` names it: the copy holds a host out of
    /// the bin, which it takes as readable, and the item's own title-like
    /// fields hold no text. A host with no name is `Untitled`, as the
    /// server names it (`types/item-name-empty`).
    fn display_held(
        &self,
        conn: &Connection,
        id: &str,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Result<ItemDisplay, CoreError>;

    /// Refuses a write whose request body, `payload`, is larger than the
    /// server said it takes (`queue-and-verdicts/request-over-limit-unsent`).
    fn refuse_over_request_limit(&self, payload: &str) -> Result<(), CoreError>;
}

impl CatalogExt for Catalog {
    fn shown(&self, item: &Item) -> Shown {
        let text = |property: &str| {
            item.properties
                .get(property)
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        Shown {
            title: text(self.title_property(&item.r#type)),
            body: text(self.body_property(&item.r#type)),
            unreadable_properties: None,
        }
    }

    fn shown_unreadable(&self, item: &Item, unreadable: &Unreadable) -> Shown {
        Shown {
            unreadable_properties: unreadable.why(&item.id),
            ..self.shown(item)
        }
    }

    fn display_held(
        &self,
        conn: &Connection,
        id: &str,
        type_id: &str,
        properties: &Map<String, Value>,
    ) -> Result<ItemDisplay, CoreError> {
        if marfa_rules::display::title_name(properties, self.title_field(type_id)).is_none()
            && let Some(host) = store::naming_host(conn, id)?
        {
            let host_name = self
                .display(&host.r#type, &host.properties)
                .name
                .unwrap_or_else(|| "Untitled".into());
            return Ok(marfa_rules::display::part_display(
                properties,
                self.body_field(type_id),
                &host.label,
                &host_name,
            ));
        }
        Ok(self.display(type_id, properties))
    }

    fn refuse_over_request_limit(&self, payload: &str) -> Result<(), CoreError> {
        match crate::model::over_request_limit(payload.len(), self.request_limit()) {
            Some(words) => Err(CoreError::Validation {
                status: None,
                code: crate::model::OVER_REQUEST_LIMIT.into(),
                message: format!("{}{words}", crate::model::OVER_REQUEST_LIMIT_WRITE),
                details: None,
            }),
            None => Ok(()),
        }
    }
}

/// An edge type as the held rows read, built without a store.
#[cfg(test)]
pub(crate) fn edge_type_for_tests(
    id: &str,
    reverse_name: Option<&str>,
    written_at: marfa_rules::catalog::End,
    cardinality: &str,
) -> EdgeType {
    EdgeType {
        id: id.into(),
        label: id.into(),
        reverse_label: id.into(),
        description: None,
        cardinality: cardinality.into(),
        reverse_name: reverse_name.map(str::to_string),
        written_at: written_at.into(),
        source_type_constraints: vec!["*".into()],
        target_type_constraints: vec!["*".into()],
        cascade_on_delete: "orphan".into(),
        properties: Vec::new(),
        shipped: false,
        acyclic: false,
        flat: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use marfa_rules::catalog::WrittenAt;
    use serde_json::json;

    fn held(types: serde_json::Value, edge_types: serde_json::Value) -> Connection {
        let conn = store::open_in_memory().unwrap();
        let catalog = marfa_rules::wire::WireCatalog {
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
                  "display_hints": { "title_field": "name", "body_field": "note", "icon": "lucide:box" } },
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
            (
                leaf.title_field.as_deref(),
                leaf.body_field.as_deref(),
                leaf.icon.as_deref()
            ),
            (Some("name"), Some("note"), Some("lucide:box")),
            "each hint comes from the nearest type that sets it"
        );
        assert_eq!(leaf.label.as_deref(), Some("Leaf"));
        assert_eq!(leaf.parent.as_deref(), Some("acme.mid"));
        assert_eq!(item_types(&conn).unwrap().len(), 3);
    }

    #[test]
    fn a_field_reads_with_the_nearest_label_its_chain_names_and_a_type_with_its_plural() {
        let entries = |label: Option<&str>| {
            let mut member = serde_json::json!({ "type": "string" });
            if let Some(label) = label {
                member["label"] = label.into();
            }
            serde_json::json!({ "type": "array", "items_type": "object",
                                "items_fields": { "phone_number": member } })
        };
        let conn = held(
            serde_json::json!([
                { "id": "acme.person", "label": "Person", "plural": "People",
                  "fields": { "score": { "type": "integer", "label": "Given" },
                              "due_at": { "type": "string" },
                              "contacts": entries(Some("Given Member")) } },
                { "id": "acme.author", "parent": "acme.person", "label": "Story",
                  "fields": { "score": { "type": "integer", "description": "again" },
                              "contacts": entries(None) } },
                { "id": "acme.editor", "parent": "acme.person",
                  "fields": { "score": { "type": "integer", "label": "Mine" },
                              "contacts": entries(Some("My Member")) } },
                { "id": "acme.bare", "fields": { "contacts": entries(None) } }
            ]),
            serde_json::json!([]),
        );
        let labels = |id: &str| -> Vec<(String, String, Option<String>)> {
            item_type(&conn, id)
                .unwrap()
                .fields
                .into_iter()
                .map(|field| {
                    let member = field.definition["items_fields"]["phone_number"]["label"]
                        .as_str()
                        .map(str::to_string);
                    let defined = field.definition["label"].as_str().unwrap().to_string();
                    assert_eq!(defined, field.label, "{id}.{}", field.name);
                    (field.name, field.label, member)
                })
                .collect()
        };
        let row = |name: &str, label: &str, member: Option<&str>| {
            (
                name.to_string(),
                label.to_string(),
                member.map(str::to_string),
            )
        };
        assert_eq!(
            labels("acme.author"),
            [
                row("contacts", "Contacts", Some("Given Member")),
                row("due_at", "Due At", None),
                row("score", "Given", None),
            ],
            "a declaration that names no label keeps the one above it"
        );
        assert_eq!(
            labels("acme.editor"),
            [
                row("contacts", "Contacts", Some("My Member")),
                row("due_at", "Due At", None),
                row("score", "Mine", None),
            ]
        );
        assert_eq!(
            labels("acme.person")[2],
            row("score", "Given", None),
            "a child's label reached its parent"
        );
        assert_eq!(
            labels("acme.bare"),
            [row("contacts", "Contacts", Some("Phone Number"))]
        );

        let plural = |id: &str| item_type(&conn, id).unwrap().plural;
        assert_eq!(plural("acme.person"), "People");
        assert_eq!(
            plural("acme.author"),
            "Stories",
            "a plural made from its own label, not its parent's"
        );
        assert_eq!(plural("acme.editor"), "Editors", "a type with no label");
    }

    #[test]
    fn a_status_field_declared_again_keeps_the_words_above_it_and_adds_its_own() {
        let words = |list: &[(&str, &str)]| {
            Value::Array(
                list.iter()
                    .map(|(value, group)| json!({ "value": value, "group": group }))
                    .collect(),
            )
        };
        let conn = held(
            json!([
                { "id": "acme.task",
                  "fields": { "status": { "type": "status", "description": "Where it stands",
                                          "status_values": words(&[("todo", "not_started"), ("done", "completed")]) } } },
                { "id": "acme.chore", "parent": "acme.task",
                  "fields": { "status": { "type": "status", "required": true,
                                          "status_values": words(&[("waiting", "in_progress"), ("todo", "canceled")]) } } },
                { "id": "acme.errand", "parent": "acme.chore",
                  "fields": { "status": { "type": "status" } } },
                { "id": "acme.list", "parent": "acme.task",
                  "fields": { "status": { "type": "string" } } }
            ]),
            json!([]),
        );
        let errand = item_type(&conn, "acme.errand").unwrap();
        let status = &errand.fields[0];
        assert_eq!(status.declared_by, "acme.errand");
        assert!(
            status.required,
            "a declaration that leaves required out dropped it"
        );
        assert_eq!(status.description.as_deref(), Some("Where it stands"));
        assert_eq!(
            status.definition["status_values"],
            words(&[
                ("todo", "not_started"),
                ("done", "completed"),
                ("waiting", "in_progress")
            ]),
            "the chain's words were not joined root first, each word once in the group it first took"
        );
        let list = item_type(&conn, "acme.list").unwrap();
        assert_eq!(
            list.fields[0].definition,
            json!({ "type": "string", "label": "Status" })
        );

        let catalog = load(&conn).unwrap();
        let fields = catalog.status_fields();
        let named: Vec<(&str, usize)> = fields
            .iter()
            .map(|field| (field.type_id.as_str(), field.words.len()))
            .collect();
        assert_eq!(
            named,
            [("acme.chore", 3), ("acme.errand", 3), ("acme.task", 2)]
        );
        let required = |type_id: &str| {
            catalog
                .validate_properties(type_id, &Map::new(), true)
                .is_err()
        };
        assert!(required("acme.errand") && !required("acme.task"));
    }

    #[test]
    fn every_reader_takes_each_hint_from_the_nearest_type_that_sets_it() {
        let conn = held(
            serde_json::json!([
                { "id": "acme.base", "fields": { "name": { "type": "string" } },
                  "display_hints": { "title_field": "name", "body_field": "text", "icon": "lucide:box" } },
                { "id": "acme.leaf", "parent": "acme.base",
                  "fields": { "comment": { "type": "string" } },
                  "display_hints": { "body_field": "comment" } },
                { "id": "acme.starred", "parent": "acme.base", "fields": {},
                  "display_hints": { "icon": "lucide:star" } },
                { "id": "acme.titled", "parent": "acme.starred",
                  "fields": { "label": { "type": "string" } },
                  "display_hints": { "title_field": "label" } },
                { "id": "acme.bare", "parent": "acme.base", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        let catalog = load(&conn).unwrap();
        let hints = |id: &str| {
            (
                catalog.title_field(id).map(str::to_string),
                catalog.body_field(id).map(str::to_string),
                catalog.icon(id).map(str::to_string),
            )
        };
        let some = |value: &str| Some(value.to_string());
        assert_eq!(
            hints("acme.leaf"),
            (some("name"), some("comment"), some("lucide:box")),
            "a subtype naming only its body lost its parent's title or icon"
        );
        assert_eq!(
            hints("acme.starred"),
            (some("name"), some("text"), some("lucide:star")),
            "a subtype naming only an icon lost its parent's title or body"
        );
        assert_eq!(
            hints("acme.titled"),
            (some("label"), some("text"), some("lucide:star")),
            "a hint was not taken from the nearest type that sets it"
        );
        assert_eq!(
            hints("acme.bare"),
            (some("name"), some("text"), some("lucide:box"))
        );
        assert_eq!(hints("acme.unheld"), (None, None, None));
        let leaf = item_type(&conn, "acme.leaf").unwrap();
        assert_eq!(
            (
                leaf.title_field.as_deref(),
                leaf.body_field.as_deref(),
                leaf.icon.as_deref()
            ),
            (Some("name"), Some("comment"), Some("lucide:box"))
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
                { "id": "acme.person.fan", "parent": "acme.person",
                  "fields": { "quote": { "type": "string" } },
                  "display_hints": { "body_field": "quote" } },
                { "id": "acme.plain", "fields": {} }
            ]),
            serde_json::json!([]),
        );
        let catalog = load(&conn).unwrap();
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
            capture_latitude: None,
            capture_longitude: None,
            trashed_at: None,
            read_only: false,
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
        assert_eq!(
            shown(
                "acme.person.fan",
                serde_json::json!({ "name": "N", "quote": "Q", "title": "T" })
            ),
            (text("N"), text("Q")),
            "a subtype naming only its body lost its parent's title field"
        );
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
            let catalog = |field: &str| marfa_rules::wire::WireCatalog {
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
        let catalog = marfa_rules::wire::WireCatalog {
            types: serde_json::from_value(serde_json::json!([{ "id": "acme.note", "fields": {} }]))
                .unwrap(),
            edge_types: vec![
                serde_json::json!({ "id": "references", "label": "References", "reverse_label": "Referenced by", "cardinality": "many-to-many", "source_type_constraints": ["*"], "target_type_constraints": ["*"], "cascade_on_delete": "orphan", "property_schema": {}, "shipped": true, "written_at": "source" }),
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
        let catalog = marfa_rules::wire::WireCatalog {
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
        let catalog = marfa_rules::wire::WireCatalog {
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
            let catalog = marfa_rules::wire::WireCatalog {
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
        let catalog = marfa_rules::wire::WireCatalog {
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
        let catalog = marfa_rules::wire::WireCatalog {
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
                &marfa_rules::wire::WireCatalog {
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
        let catalog = |reverse: &str| marfa_rules::wire::WireCatalog {
            types: Vec::new(),
            edge_types: vec![serde_json::json!({
                "id": "mentor-of", "label": "Mentees", "reverse_label": "Mentors",
                "cardinality": "one-to-many",
                "source_type_constraints": ["*"], "target_type_constraints": ["*"],
                "cascade_on_delete": "orphan", "property_schema": {},
                "reverse_name": reverse, "written_at": "target", "shipped": false
            })],
        };
        assert!(
            store::replace_catalog(&conn, &catalog("mentored-by"))
                .unwrap()
                .is_changed()
        );
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
        assert!(
            !store::replace_catalog(&conn, &catalog("mentored-by"))
                .unwrap()
                .is_changed()
        );
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(1));
        assert!(
            store::replace_catalog(&conn, &catalog("taught-by"))
                .unwrap()
                .is_changed()
        );
        assert_eq!(store::catalog_version(&conn).unwrap(), Some(2));
        let mentor = edge_type(&conn, "mentor-of").unwrap();
        assert_eq!(
            (mentor.reverse_name.as_deref(), mentor.written_at),
            (Some("taught-by"), WrittenAt::Target)
        );
        assert_eq!(
            (mentor.label.as_str(), mentor.reverse_label.as_str()),
            ("Mentees", "Mentors")
        );
    }

    #[test]
    fn a_held_edge_type_without_its_labels_reads_with_the_ones_the_server_makes() {
        let conn = store::open_in_memory().unwrap();
        let catalog = marfa_rules::wire::WireCatalog {
            types: Vec::new(),
            edge_types: vec![
                serde_json::json!({
                    "id": "acme.mentor-of", "cardinality": "one-to-many",
                    "source_type_constraints": ["*"], "target_type_constraints": ["*"],
                    "cascade_on_delete": "orphan", "property_schema": {},
                    "written_at": "source", "shipped": false
                }),
                serde_json::json!({
                    "id": "acme.reviews", "label": "Reviews", "cardinality": "one-to-many",
                    "source_type_constraints": ["*"], "target_type_constraints": ["*"],
                    "cascade_on_delete": "orphan", "property_schema": {},
                    "written_at": "source", "shipped": false
                }),
            ],
        };
        store::replace_catalog(&conn, &catalog).unwrap();
        let held = edge_type(&conn, "acme.mentor-of").unwrap();
        assert_eq!(
            (held.label.as_str(), held.reverse_label.as_str()),
            ("Mentor Of", "Mentor Of")
        );
        let labelled = edge_type(&conn, "acme.reviews").unwrap();
        assert_eq!(
            (labelled.label.as_str(), labelled.reverse_label.as_str()),
            ("Reviews", "Reviews")
        );
    }
}
