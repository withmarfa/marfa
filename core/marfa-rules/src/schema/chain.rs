//! How long a parent chain may be, and which types a change reaches.

use std::collections::HashSet;

use super::{Issue, Registry, text, validate_type};

/// The most ancestors a type may have, counting the levels of subtypes below
/// it that would move with it.
pub const MAX_REGISTRATION_CHAIN_DEPTH: usize = 10;

/// Why `parent` cannot be the parent of `type_id`, in words, where it cannot.
pub fn parent_chain_fault(
    registry: &Registry,
    type_id: &str,
    parent: &str,
    descendant_depth: usize,
) -> Option<String> {
    let mut current = parent;
    let mut depth = 0;
    loop {
        depth += 1;
        if depth + descendant_depth > MAX_REGISTRATION_CHAIN_DEPTH {
            return Some(if descendant_depth > 0 {
                format!(
                    "Inheritance chain exceeds maximum depth of {MAX_REGISTRATION_CHAIN_DEPTH}: this type carries {descendant_depth} level(s) of subtypes, which count toward the limit"
                )
            } else {
                format!("Inheritance chain exceeds maximum depth of {MAX_REGISTRATION_CHAIN_DEPTH}")
            });
        }
        if current == type_id {
            return Some("Circular inheritance detected".into());
        }
        let Some(held) = registry.get(current) else {
            return Some(if current == parent {
                format!("Parent type \"{parent}\" not found")
            } else {
                format!(
                    "Parent type \"{parent}\" resolves, but its own ancestor \"{current}\" does not"
                )
            });
        };
        current = text(held, "parent")?;
    }
}

/// The levels of subtypes below `id`, the longest path.
pub fn descendant_depth(registry: &Registry, id: &str) -> usize {
    let mut deepest = 0;
    let mut stack: Vec<(String, usize, HashSet<String>)> =
        vec![(id.to_string(), 0, HashSet::from([id.to_string()]))];
    while let Some((at, depth, path)) = stack.pop() {
        deepest = deepest.max(depth);
        for child in registry.children_of(&at) {
            if path.contains(child) {
                continue;
            }
            let mut below = path.clone();
            below.insert(child.to_string());
            stack.push((child.to_string(), depth + 1, below));
        }
    }
    deepest
}

/// The types with a `compatible_with` claim that a change to `changed`
/// breaks, each with its faults, sorted by id. A claim is reached when its
/// type, or a target of it, is changed or below a changed type.
pub fn broken_compatible_dependents(
    registry: &Registry,
    changed: &[&str],
) -> Vec<(String, Vec<Issue>)> {
    let mut affected: HashSet<String> = changed.iter().map(|id| id.to_string()).collect();
    loop {
        let before = affected.len();
        for id in registry.ids() {
            if registry
                .parent_of(id)
                .is_some_and(|parent| affected.contains(parent))
            {
                affected.insert(id.to_string());
            }
        }
        if affected.len() == before {
            break;
        }
    }
    let mut broken = Vec::new();
    for id in registry.ids() {
        let Some(row) = registry.get(id) else {
            continue;
        };
        let targets: Vec<&str> = row
            .get("compatible_with")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .collect();
        if targets.is_empty()
            || !(affected.contains(id) || targets.iter().any(|t| affected.contains(*t)))
        {
            continue;
        }
        let issues: Vec<Issue> = validate_type(&serde_json::Value::Object(row.clone()), registry)
            .err()
            .unwrap_or_default()
            .into_iter()
            .filter(|issue| issue.code == Some("compatible_with_violation"))
            .map(|mut issue| {
                issue.field = format!("types.{id}.{}", issue.field);
                issue
            })
            .collect();
        if !issues.is_empty() {
            broken.push((id.to_string(), issues));
        }
    }
    broken
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn registry(rows: &[serde_json::Value]) -> Registry {
        Registry::new(rows.iter().filter_map(|row| row.as_object().cloned()))
    }

    #[test]
    fn a_parent_that_closes_a_loop_or_is_missing_is_named() {
        let held = registry(&[
            json!({"id": "user.a", "parent": "user.b", "fields": {}}),
            json!({"id": "user.b", "fields": {}}),
        ]);
        assert_eq!(
            parent_chain_fault(&held, "user.b", "user.a", 0).as_deref(),
            Some("Circular inheritance detected")
        );
        assert_eq!(
            parent_chain_fault(&held, "user.c", "user.zz", 0).as_deref(),
            Some("Parent type \"user.zz\" not found")
        );
        assert_eq!(parent_chain_fault(&held, "user.c", "user.a", 0), None);
    }

    #[test]
    fn the_levels_below_a_type_count_toward_the_limit() {
        let mut rows = vec![json!({"id": "user.t0", "fields": {}})];
        for level in 1..=9 {
            rows.push(json!({"id": format!("user.t{level}"), "parent": format!("user.t{}", level - 1), "fields": {}}));
        }
        let held = registry(&rows);
        assert_eq!(parent_chain_fault(&held, "user.new", "user.t9", 0), None);
        assert!(parent_chain_fault(&held, "user.new", "user.t9", 1).is_some());
        assert_eq!(descendant_depth(&held, "user.t0"), 9);
    }
}
