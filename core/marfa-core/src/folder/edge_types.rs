//! The edge types a folder reads frontmatter lines by, as the server lists
//! them (`edges.md` 2, 18), so a registered type is read like a shipped one.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CoreError;
use crate::http::Http;

/// Where the folder keeps the list between runs.
const META_EDGE_TYPES: &str = "folder_edge_types";

/// One end of an edge.
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeType {
    pub id: String,
    #[serde(default)]
    pub reverse_name: Option<String>,
    #[serde(default = "source")]
    pub written_at: End,
    #[serde(default)]
    pub cardinality: String,
}

fn source() -> End {
    End::Source
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
}

/// Every edge type the folder knows, in the server's order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EdgeTypes {
    types: Vec<EdgeType>,
}

impl EdgeTypes {
    /// The list as the server holds it now, kept for the passes after.
    pub fn refresh(http: &Http, conn: &Connection) -> Result<EdgeTypes, CoreError> {
        let listed = http.edge_types()?;
        let types = listed
            .into_iter()
            .map(serde_json::from_value::<EdgeType>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                CoreError::Decoding(format!("an edge type the server listed: {error}"))
            })?;
        crate::store::meta_set(conn, META_EDGE_TYPES, &serde_json::to_string(&types)?)?;
        Ok(EdgeTypes { types })
    }

    /// The list the last refresh kept. A folder refreshes it when it is
    /// added, so none kept is a folder to add again.
    pub fn load(conn: &Connection) -> Result<EdgeTypes, CoreError> {
        match crate::store::meta_get(conn, META_EDGE_TYPES)? {
            Some(json) => Ok(EdgeTypes {
                types: serde_json::from_str(&json)?,
            }),
            None => Err(CoreError::Invalid(
                "this folder has not read the server's edge types, so it cannot tell an edge's line from a property; hydrate it again".into(),
            )),
        }
    }

    #[cfg(test)]
    pub fn of(types: Vec<EdgeType>) -> EdgeTypes {
        EdgeTypes { types }
    }

    pub fn get(&self, id: &str) -> Option<&EdgeType> {
        self.types.iter().find(|held| held.id == id)
    }

    /// The type a frontmatter line of this name is an edge of, and the end of
    /// it the file names itself as.
    pub fn named(&self, name: &str) -> Option<(&EdgeType, End)> {
        self.types.iter().find_map(|held| {
            if held.id == name {
                Some((held, End::Source))
            } else if held.reverse_name.as_deref() == Some(name) {
                Some((held, End::Target))
            } else {
                None
            }
        })
    }

    pub fn is_name(&self, name: &str) -> bool {
        self.named(name).is_some()
    }

    /// The types written at their target: a copy holds such an edge from
    /// the target's side only when it holds the type whole (`device.md` 1).
    pub fn written_at_targets(&self) -> Vec<String> {
        let mut found: Vec<String> = self
            .types
            .iter()
            .filter(|held| held.written_at == End::Target)
            .map(|held| held.id.clone())
            .collect();
        found.sort();
        found
    }
}

/// The targets a line names, once each whatever their case; unquoted
/// `[[name]]` is YAML for a list inside a list.
pub fn targets(value: &Value) -> Result<Vec<String>, String> {
    let named: Vec<&Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(_) if is_bare_link(value) => vec![value],
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut found = Vec::new();
    for value in named {
        let text = match value {
            Value::String(text) => text
                .trim()
                .strip_prefix("[[")
                .and_then(|rest| rest.strip_suffix("]]"))
                .map(str::to_string),
            bare if is_bare_link(bare) => bare[0][0].as_str().map(str::to_string),
            _ => None,
        };
        let Some(text) = text else {
            return Err(format!("{value} is not written as [[name]]"));
        };
        // `[[name|shown]]` and `[[name#heading]]` name what is before them.
        let text = text.split(['|', '#']).next().unwrap_or_default().trim();
        if text.is_empty() {
            return Err("[[]] names nothing".into());
        }
        if !found
            .iter()
            .any(|held: &String| held.to_lowercase() == text.to_lowercase())
        {
            found.push(text.to_string());
        }
    }
    Ok(found)
}

/// `[[name]]` left unquoted: a list holding one list holding one string.
fn is_bare_link(value: &Value) -> bool {
    matches!(value, Value::Array(outer) if outer.len() == 1
        && matches!(&outer[0], Value::Array(inner) if inner.len() == 1 && inner[0].is_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_line_names_its_targets_in_either_form() {
        assert_eq!(targets(&json!("[[Project]]")).unwrap(), ["Project"]);
        assert_eq!(targets(&json!([["Project"]])).unwrap(), ["Project"]);
        assert_eq!(
            targets(&json!(["[[A]]", "[[b|shown]]", "[[A]]", "[[c#part]]"])).unwrap(),
            ["A", "b", "c"]
        );
        assert_eq!(targets(&json!([[["A"]], "[[B]]"])).unwrap(), ["A", "B"]);
        assert_eq!(targets(&json!(["[[One]]", "[[one]]"])).unwrap(), ["One"]);
        assert!(targets(&json!(null)).unwrap().is_empty());
        assert!(targets(&json!("Project")).is_err());
        assert!(targets(&json!(3)).is_err());
        assert!(targets(&json!("[[ ]]")).is_err());
    }

    #[test]
    fn an_end_holds_one_edge_where_the_cardinality_says() {
        let parent = EdgeType {
            id: "parent-of".into(),
            reverse_name: Some("child-of".into()),
            written_at: End::Target,
            cardinality: "one-to-many".into(),
        };
        assert!(parent.one_at(End::Target) && !parent.one_at(End::Source));
        assert_eq!(parent.name_at(End::Target), Some("child-of"));
        let types = EdgeTypes::of(vec![parent]);
        assert_eq!(
            types.named("child-of").map(|(_, end)| end),
            Some(End::Target)
        );
        assert_eq!(
            types.named("parent-of").map(|(_, end)| end),
            Some(End::Source)
        );
        assert!(types.named("references").is_none());
    }
}
