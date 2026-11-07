//! The types a registry holds, read by id, with the walks down and up their
//! chains.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{Obj, as_obj, text};
use crate::catalog::merge_field_definition;

/// A field as the nearest type above declares it, with that type.
#[derive(Debug, Clone)]
pub struct Held {
    pub owner: String,
    pub definition: Obj,
}

/// The fields a parent chain gives, in the order the chain declares them.
#[derive(Debug, Clone, Default)]
pub struct Ancestry(Vec<(String, Held)>);

impl Ancestry {
    pub fn get(&self, name: &str) -> Option<&Held> {
        self.0.iter().find(|(held, _)| held == name).map(|(_, h)| h)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Held)> {
        self.0.iter().map(|(name, held)| (name.as_str(), held))
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(name, _)| name.as_str())
    }

    fn set(&mut self, name: &str, held: Held) {
        match self.0.iter_mut().find(|(existing, _)| existing == name) {
            Some((_, slot)) => *slot = held,
            None => self.0.push((name.to_string(), held)),
        }
    }
}

/// Stored type definitions by id.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    types: HashMap<String, Obj>,
    icons: HashMap<String, String>,
}

impl Registry {
    pub fn new(rows: impl IntoIterator<Item = Obj>) -> Registry {
        Registry {
            types: rows
                .into_iter()
                .filter_map(|row| Some((text(&row, "id")?.to_string(), row)))
                .collect(),
            icons: HashMap::new(),
        }
    }

    /// This registry with the icons owners chose, by type id.
    pub fn with_icons(mut self, icons: HashMap<String, String>) -> Registry {
        self.icons = icons;
        self
    }

    /// This registry with `icon` as the owner's choice for `id`, or with none
    /// where `icon` is `None`.
    pub fn with_icon(&self, id: &str, icon: Option<&str>) -> Registry {
        let mut next = self.clone();
        match icon {
            Some(icon) => next.icons.insert(id.to_string(), icon.to_string()),
            None => next.icons.remove(id),
        };
        next
    }

    pub fn icon_of(&self, id: &str) -> Option<&str> {
        self.icons.get(id).map(String::as_str)
    }

    /// The type as it reads: its owner's icon, where there is one, in place of
    /// the icon its author set.
    pub fn owned(&self, id: &str) -> Option<Obj> {
        let mut row = self.get(id)?.clone();
        if let Some(icon) = self.icon_of(id) {
            let mut hints = as_obj(row.get("display_hints"))
                .cloned()
                .unwrap_or_default();
            hints.insert("icon".into(), Value::String(icon.to_string()));
            row.insert("display_hints".into(), Value::Object(hints));
        }
        Some(row)
    }

    pub fn get(&self, id: &str) -> Option<&Obj> {
        self.types.get(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.types.contains_key(id)
    }

    /// Every id, sorted.
    pub fn ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.types.keys().map(String::as_str).collect();
        ids.sort_unstable();
        ids
    }

    pub fn rows(&self) -> &HashMap<String, Obj> {
        &self.types
    }

    /// This registry with `row` held, in place of any type of its id.
    pub fn with(&self, row: Obj) -> Registry {
        let mut next = self.clone();
        if let Some(id) = text(&row, "id").map(str::to_string) {
            next.types.insert(id, row);
        }
        next
    }

    pub fn without(&self, id: &str) -> Registry {
        let mut next = self.clone();
        next.types.remove(id);
        next.icons.remove(id);
        next
    }

    pub fn parent_of(&self, id: &str) -> Option<&str> {
        self.get(id).and_then(|row| text(row, "parent"))
    }

    /// The types that name `id` as their parent, sorted.
    pub fn children_of(&self, id: &str) -> Vec<&str> {
        let mut children: Vec<&str> = self
            .types
            .iter()
            .filter(|(_, row)| text(row, "parent") == Some(id))
            .map(|(child, _)| child.as_str())
            .collect();
        children.sort_unstable();
        children
    }

    /// The types whose parent chain reaches `id`, not `id` itself, by id.
    pub fn descendants(&self, id: &str) -> Vec<&Obj> {
        let mut found: Vec<&Obj> = self
            .types
            .iter()
            .filter(|(candidate, _)| candidate.as_str() != id && self.reaches(candidate, id))
            .map(|(_, row)| row)
            .collect();
        found.sort_by(|a, b| text(a, "id").cmp(&text(b, "id")));
        found
    }

    fn reaches(&self, from: &str, top: &str) -> bool {
        let mut seen = HashSet::new();
        let mut cursor = self.parent_of(from);
        while let Some(at) = cursor {
            if at == top {
                return true;
            }
            if !seen.insert(at) {
                return false;
            }
            cursor = self.parent_of(at);
        }
        false
    }

    /// The fields the chain from `parent` up gives, root first. A chain that
    /// loops or names a type this registry lacks ends there.
    pub fn ancestry(&self, parent: &str) -> Ancestry {
        let mut seen = HashSet::new();
        let mut chain: Vec<&Obj> = Vec::new();
        let mut cursor = Some(parent);
        while let Some(at) = cursor {
            if !seen.insert(at) {
                break;
            }
            let Some(row) = self.get(at) else { break };
            chain.push(row);
            cursor = text(row, "parent");
        }
        let mut held = Ancestry::default();
        for row in chain.into_iter().rev() {
            let owner = text(row, "id").unwrap_or_default();
            for (name, own) in as_obj(row.get("fields")).into_iter().flatten() {
                let above = held.get(name).map(|h| Value::Object(h.definition.clone()));
                let Value::Object(definition) = merge_field_definition(above.as_ref(), own) else {
                    continue;
                };
                held.set(
                    name,
                    Held {
                        owner: owner.to_string(),
                        definition,
                    },
                );
            }
        }
        held
    }

    /// Whether a declaration of `name` sits between `child` and `top`, the
    /// two included at the child's end.
    pub fn declared_between(&self, child: &Obj, top: &str, name: &str) -> bool {
        let mut seen = HashSet::new();
        let mut cursor = Some(child);
        while let Some(row) = cursor {
            let id = text(row, "id").unwrap_or_default();
            if id == top || !seen.insert(id) {
                return false;
            }
            if as_obj(row.get("fields")).is_some_and(|fields| fields.contains_key(name)) {
                return true;
            }
            cursor = text(row, "parent").and_then(|parent| self.get(parent));
        }
        false
    }
}
