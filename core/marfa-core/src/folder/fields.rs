//! What a file's frontmatter lines mean (`folders.md` 7): the item's own
//! fields, the lines that name it, edges, and every other line a property.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::model::{Item, ItemState, Tier};

/// The frontmatter field that names the item a Markdown file is.
pub const ID_FIELD: &str = "marfa_id";

/// The frontmatter field that names the version a Markdown file was written
/// from, which an edit from it is based on (`folders.md` 22).
pub const VERSION_FIELD: &str = "marfa_version";

pub const TYPE_FIELD: &str = "type";
pub const TIER_FIELD: &str = "tier";
pub const TAGS_FIELD: &str = "tags";
pub const STATE_FIELD: &str = "state";

/// The property a file's body is carried in where its type names none.
pub const BODY_FIELD: &str = "body";

/// The property a file's name is carried in where its type names none.
pub const TITLE_FIELD: &str = "title";

/// The shipped edge types and their reverse names, which a file writes as
/// edges rather than properties.
const EDGE_NAMES: &[&str] = &[
    "about",
    "attached-to",
    "has-attachment",
    "authored-by",
    "derived-from",
    "in-collection",
    "in-folder",
    "in-thread",
    "parent-of",
    "child-of",
    "references",
    "supersedes",
];

/// Whether a frontmatter line of this name is anything but a property.
pub fn reserved(name: &str) -> bool {
    matches!(
        name,
        ID_FIELD | VERSION_FIELD | TYPE_FIELD | TIER_FIELD | TAGS_FIELD | STATE_FIELD
    ) || EDGE_NAMES.contains(&name)
}

/// The item's own fields, as the folder last agreed them with a file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Own {
    pub r#type: String,
    pub tier: Option<Tier>,
    pub tags: Vec<String>,
    pub state: ItemState,
}

impl Own {
    pub fn of(item: &Item) -> Own {
        let mut tags = item.tags.clone();
        tags.sort();
        Own {
            r#type: item.r#type.clone(),
            tier: item.tier,
            tags,
            state: item.state,
        }
    }
}

/// A file's own-field lines, each `None` where the file has no such line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lines {
    pub r#type: Option<String>,
    pub tier: Option<Tier>,
    pub tags: Option<Vec<String>>,
    pub state: Option<ItemState>,
}

/// A Markdown file's frontmatter, read as an item's.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Read {
    pub lines: Lines,
    /// Every line that is a property, in the file's order.
    pub properties: Map<String, Value>,
}

/// Splits frontmatter into the item's own fields and its properties. Lines
/// naming the item, its version or an edge are neither. The reason where an
/// own field holds what no item can.
pub fn read(front: &Map<String, Value>) -> Result<Read, String> {
    let mut read = Read::default();
    for (name, value) in front {
        match name.as_str() {
            TYPE_FIELD => {
                read.lines.r#type = match value {
                    Value::String(named) if !named.trim().is_empty() => {
                        Some(named.trim().to_string())
                    }
                    _ => return Err(format!("{TYPE_FIELD} names no type: {value}")),
                }
            }
            TIER_FIELD => {
                read.lines.tier = Some(
                    value
                        .as_str()
                        .and_then(|tier| tier.parse().ok())
                        .ok_or_else(|| format!("{TIER_FIELD} is feed or library, not {value}"))?,
                );
            }
            TAGS_FIELD => read.lines.tags = Some(tags_of(value)?),
            STATE_FIELD => {
                read.lines.state = Some(match value {
                    Value::Null => ItemState::Active,
                    Value::String(state) if state == "active" => ItemState::Active,
                    Value::String(state) if state == "archived" => ItemState::Archived,
                    _ => {
                        return Err(format!(
                            "{STATE_FIELD} is active or archived in a file, not {value}"
                        ));
                    }
                });
            }
            name if reserved(name) => {}
            _ => {
                read.properties.insert(name.clone(), value.clone());
            }
        }
    }
    Ok(read)
}

/// A `tags` line: a list of tags, one tag, or nothing.
fn tags_of(value: &Value) -> Result<Vec<String>, String> {
    let named: Vec<&Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(tags) => tags.iter().collect(),
        tag @ Value::String(_) => vec![tag],
        other => return Err(format!("{TAGS_FIELD} is a list of tags, not {other}")),
    };
    let mut tags = Vec::new();
    for tag in named {
        match tag.as_str().map(str::trim) {
            Some(tag) if !tag.is_empty() => {
                if !tags.iter().any(|held| held == tag) {
                    tags.push(tag.to_string());
                }
            }
            _ => return Err(format!("{TAGS_FIELD} holds {tag}, which is not a tag")),
        }
    }
    Ok(tags)
}

/// The item's own fields as frontmatter lines: the type and tier always,
/// the tags where it has any and the state where it is archived.
pub fn lines_of(item: &Item) -> Map<String, Value> {
    let mut lines = Map::new();
    lines.insert(TYPE_FIELD.into(), Value::String(item.r#type.clone()));
    if let Some(tier) = item.tier {
        lines.insert(TIER_FIELD.into(), Value::String(tier.as_str().into()));
    }
    if !item.tags.is_empty() {
        let mut tags = item.tags.clone();
        tags.sort();
        lines.insert(
            TAGS_FIELD.into(),
            Value::Array(tags.into_iter().map(Value::String).collect()),
        );
    }
    if item.state == ItemState::Archived {
        lines.insert(STATE_FIELD.into(), Value::String("archived".into()));
    }
    lines
}

/// The property a type's file body is, and the one its file name is.
pub fn body_field<'a>(catalog: &'a Catalog, r#type: &str) -> &'a str {
    catalog.body_field(r#type).unwrap_or(BODY_FIELD)
}

pub fn title_field<'a>(catalog: &'a Catalog, r#type: &str) -> &'a str {
    catalog.title_field(r#type).unwrap_or(TITLE_FIELD)
}

/// A property a type declares under a name a file cannot carry as one.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Uncarried {
    pub r#type: String,
    pub property: String,
}

/// Every such property among the types a folder holds, sorted.
pub fn uncarried(catalog: &Catalog, holds: impl Fn(&str) -> bool) -> Vec<Uncarried> {
    let mut found: Vec<Uncarried> = catalog
        .declared()
        .filter(|(r#type, _)| !r#type.starts_with("system.") && holds(r#type))
        .flat_map(|(r#type, fields)| {
            fields
                .iter()
                .filter(|property| reserved(property))
                .map(move |property| Uncarried {
                    r#type: r#type.to_string(),
                    property: property.clone(),
                })
        })
        .collect();
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn front(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else {
            unreachable!()
        };
        map
    }

    #[test]
    fn own_fields_are_read_apart_from_properties() {
        let read = read(&front(json!({
            "title": "A",
            "type": "core.task",
            "tier": "feed",
            "tags": ["b", "a", "b"],
            "state": "archived",
            "marfa_id": "x",
            "marfa_version": 3,
            "child-of": "[[P]]",
            "status": "open",
        })))
        .unwrap();
        assert_eq!(read.lines.r#type.as_deref(), Some("core.task"));
        assert_eq!(read.lines.tier, Some(Tier::Feed));
        assert_eq!(read.lines.tags, Some(vec!["b".into(), "a".into()]));
        assert_eq!(read.lines.state, Some(ItemState::Archived));
        assert_eq!(
            read.properties.keys().collect::<Vec<_>>(),
            ["title", "status"],
            "a line naming the item, its version, an own field or an edge was read as a property"
        );
        assert_eq!(
            super::read(&front(json!({ "tags": "solo" })))
                .unwrap()
                .lines
                .tags,
            Some(vec!["solo".into()])
        );
    }

    #[test]
    fn an_own_field_no_item_can_hold_is_refused() {
        for bad in [
            json!({ "type": 3 }),
            json!({ "type": " " }),
            json!({ "tier": "attic" }),
            json!({ "tags": { "a": 1 } }),
            json!({ "tags": [1] }),
            json!({ "state": "trashed" }),
        ] {
            assert!(read(&front(bad.clone())).is_err(), "{bad}");
        }
    }
}
