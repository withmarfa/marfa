use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::edge_types::EdgeTypes;
use crate::catalog::Catalog;
use crate::model::{Item, ItemState, Tier};

pub const ID_FIELD: &str = "marfa_id";

/// The version a Markdown file was written from, which an edit from it is
/// based on.
pub const VERSION_FIELD: &str = "marfa_version";

pub const TYPE_FIELD: &str = "type";
pub const TIER_FIELD: &str = "tier";
pub const TAGS_FIELD: &str = "tags";
pub const STATE_FIELD: &str = "state";

/// The property a file's body is carried in where its type names none.
pub const BODY_FIELD: &str = "body";

/// The property a file's name is carried in where its type names none.
pub const TITLE_FIELD: &str = "title";

/// Whether a frontmatter line of this name is anything but a property: a
/// line naming the item, its version, one of its own fields, or an edge.
pub fn reserved(name: &str, edge_types: &EdgeTypes) -> bool {
    matches!(
        name,
        ID_FIELD | VERSION_FIELD | TYPE_FIELD | TIER_FIELD | TAGS_FIELD | STATE_FIELD
    ) || edge_types.is_name(name)
}

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

/// What the folder last wrote or read of a file's own fields, at its version line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnBase {
    pub line: i64,
    pub agreed: Own,
    /// Values another machine moved away from at this line, which an old buffer
    /// may still show and a person's change cannot be told from.
    #[serde(default)]
    pub moved: Moved,
}

/// Tags and states an old buffer at one version line may still show.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Moved {
    pub tags_added: BTreeSet<String>,
    pub tags_removed: BTreeSet<String>,
    pub states: Vec<ItemState>,
}

impl OwnBase {
    /// A pull's write of `own` at `line`: what moved since the last agreement
    /// at that line is another machine's, since this folder agrees its own on reading.
    pub fn written(was: Option<&OwnBase>, line: i64, own: Own) -> OwnBase {
        let mut moved = Moved::default();
        if let Some(was) = was.filter(|was| was.line == line) {
            moved = was.moved.clone();
            let before = &was.agreed;
            moved.tags_added.extend(
                own.tags
                    .iter()
                    .filter(|tag| !before.tags.contains(tag))
                    .cloned(),
            );
            moved.tags_removed.extend(
                before
                    .tags
                    .iter()
                    .filter(|tag| !own.tags.contains(tag))
                    .cloned(),
            );
            if before.state != own.state && !moved.states.contains(&before.state) {
                moved.states.push(before.state);
            }
        }
        OwnBase {
            line,
            agreed: own,
            moved,
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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Read {
    pub lines: Lines,
    pub properties: Map<String, Value>,
}

/// Lines naming the item, its version or an edge are neither own fields nor
/// properties.
pub fn read(front: &Map<String, Value>, edge_types: &EdgeTypes) -> Result<Read, String> {
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
            name if reserved(name, edge_types) => {}
            _ => {
                read.properties.insert(name.clone(), value.clone());
            }
        }
    }
    Ok(read)
}

/// A `tags` line: a list of tags, tags separated by commas, or nothing.
fn tags_of(value: &Value) -> Result<Vec<String>, String> {
    let split: Vec<Value>;
    let named: Vec<&Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(tags) => tags.iter().collect(),
        // Obsidian's older style, `tags: a, b`.
        Value::String(tags) => {
            split = tags
                .split(',')
                .map(|tag| Value::String(tag.to_string()))
                .collect();
            split.iter().collect()
        }
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
pub fn uncarried(
    catalog: &Catalog,
    edge_types: &EdgeTypes,
    holds: impl Fn(&str) -> bool,
) -> Vec<Uncarried> {
    let mut found: Vec<Uncarried> = catalog
        .declared()
        .filter(|(r#type, _)| !r#type.starts_with("system.") && holds(r#type))
        .flat_map(|(r#type, fields)| {
            fields
                .iter()
                .filter(|property| reserved(property, edge_types))
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

    fn edge_types() -> EdgeTypes {
        use crate::catalog::{EdgeType, End};
        EdgeTypes::of(vec![
            EdgeType::of("parent-of", Some("child-of"), End::Target, "one-to-many"),
            EdgeType::of("cites", Some("cited-by"), End::Source, "many-to-many"),
        ])
    }

    fn front(value: Value) -> Map<String, Value> {
        let Value::Object(map) = value else {
            unreachable!()
        };
        map
    }

    #[test]
    fn own_fields_are_read_apart_from_properties() {
        let read = read(
            &front(json!({
                "title": "A",
                "type": "core.task",
                "tier": "feed",
                "tags": ["b", "a", "b"],
                "state": "archived",
                "marfa_id": "x",
                "marfa_version": 3,
                "child-of": "[[P]]",
                "cites": "[[Q]]",
                "cited-by": "[[R]]",
                "status": "open",
            })),
            &edge_types(),
        )
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
            super::read(&front(json!({ "tags": "solo" })), &edge_types())
                .unwrap()
                .lines
                .tags,
            Some(vec!["solo".into()])
        );
        assert_eq!(
            super::read(&front(json!({ "tags": "x, y" })), &edge_types())
                .unwrap()
                .lines
                .tags,
            Some(vec!["x".into(), "y".into()])
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
            assert!(read(&front(bad.clone()), &edge_types()).is_err(), "{bad}");
        }
    }
}
