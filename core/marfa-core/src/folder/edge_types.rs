use rusqlite::Connection;
use serde_json::Value;

use crate::catalog::{EdgeType, End};
use crate::error::CoreError;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EdgeTypes {
    types: Vec<EdgeType>,
}

impl EdgeTypes {
    /// The edge types the copy holds, which hydration and catch-up keep.
    pub fn load(conn: &Connection) -> Result<EdgeTypes, CoreError> {
        Ok(EdgeTypes {
            types: crate::catalog::edge_types(conn)?,
        })
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
    /// the target's side only when it holds the type whole.
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

/// One target a line names: what was typed inside `[[ ]]`, and the name it
/// is read as, which is what comes before a `|` or a `#`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Typed {
    pub raw: String,
    pub name: String,
}

impl Typed {
    pub fn new(raw: &str) -> Typed {
        let raw = raw.trim();
        Typed {
            raw: raw.to_string(),
            name: raw
                .split(['|', '#'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string(),
        }
    }
}

/// The targets a line names, once each whatever their case or form; unquoted
/// `[[name]]` is YAML for a list inside a list.
pub fn typed(value: &Value) -> Result<Vec<Typed>, String> {
    let named: Vec<&Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(_) if is_bare_link(value) => vec![value],
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut found: Vec<Typed> = Vec::new();
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
        let Some(raw) = text else {
            return Err(format!("{value} is not written as [[name]]"));
        };
        let target = Typed::new(&raw);
        if target.name.is_empty() {
            return Err("[[]] names nothing".into());
        }
        if !found
            .iter()
            .any(|held| super::names::same(&held.raw, raw.trim()))
        {
            found.push(target);
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
        let targets = |value: &Value| {
            typed(value).map(|all| all.into_iter().map(|one| one.name).collect::<Vec<_>>())
        };
        assert_eq!(targets(&json!("[[Project]]")).unwrap(), ["Project"]);
        assert_eq!(targets(&json!([["Project"]])).unwrap(), ["Project"]);
        assert_eq!(
            targets(&json!(["[[A]]", "[[b|shown]]", "[[A]]", "[[c#part]]"])).unwrap(),
            ["A", "b", "c"]
        );
        assert_eq!(
            typed(&json!("[[Beta|the beta]]")).unwrap()[0].raw,
            "Beta|the beta"
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
        let parent = EdgeType::of("parent-of", Some("child-of"), End::Target, "one-to-many");
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
