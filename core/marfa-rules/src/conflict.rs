//! What a write against an older version means: which of its changes collide
//! with what landed since, how the type's merge policy settles a collision,
//! and the copy that keeps the losing value. Values in, values out; the write
//! that applies the answer lives with the storage.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// A rule for one colliding field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    LastWriterWins,
    KeepBothCopies,
}

impl Strategy {
    pub const fn word(self) -> &'static str {
        match self {
            Strategy::LastWriterWins => "last_writer_wins",
            Strategy::KeepBothCopies => "keep_both_copies",
        }
    }

    pub fn from_word(word: &str) -> Option<Strategy> {
        match word {
            "last_writer_wins" => Some(Strategy::LastWriterWins),
            "keep_both_copies" => Some(Strategy::KeepBothCopies),
            _ => None,
        }
    }
}

/// A type's merge policy, its chain's entries already laid over each other.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergePolicy {
    pub default: Option<Strategy>,
    pub fields: BTreeMap<String, Strategy>,
}

impl MergePolicy {
    fn strategy_for(&self, field: &str) -> Strategy {
        self.fields
            .get(field)
            .copied()
            .or(self.default)
            .unwrap_or(Strategy::LastWriterWins)
    }

    /// Lays `declared`, a type's `merge_policy` member, over this policy: its
    /// `fields` key by key, and its `default` in place of the one held.
    pub fn laid_over_by(mut self, declared: &Value) -> MergePolicy {
        if let Some(fields) = declared.get("fields").and_then(Value::as_object) {
            for (field, word) in fields {
                if let Some(strategy) = word.as_str().and_then(Strategy::from_word) {
                    self.fields.insert(field.clone(), strategy);
                }
            }
        }
        if let Some(strategy) = declared
            .get("default")
            .and_then(Value::as_str)
            .and_then(Strategy::from_word)
        {
            self.default = Some(strategy);
        }
        self
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        if !self.fields.is_empty() {
            let fields = self
                .fields
                .iter()
                .map(|(field, strategy)| (field.clone(), strategy.word().into()))
                .collect();
            out.insert("fields".into(), Value::Object(fields));
        }
        if let Some(strategy) = self.default {
            out.insert("default".into(), strategy.word().into());
        }
        Value::Object(out)
    }
}

/// The item's own versioned fields. On a write, `None` is a field it does not
/// name; on a stored version, a field that holds nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ItemFields {
    pub tier: Option<String>,
    pub occurred_at: Option<String>,
    pub source_id: Option<String>,
}

impl ItemFields {
    const NAMES: [&'static str; 3] = ["tier", "occurred_at", "source_id"];

    fn get(&self, name: &str) -> Option<&String> {
        match name {
            "tier" => self.tier.as_ref(),
            "occurred_at" => self.occurred_at.as_ref(),
            _ => self.source_id.as_ref(),
        }
    }

    fn set(&mut self, name: &str, value: String) {
        match name {
            "tier" => self.tier = Some(value),
            "occurred_at" => self.occurred_at = Some(value),
            _ => self.source_id = Some(value),
        }
    }
}

/// A stale write and the two states it meets.
#[derive(Clone, Copy, Debug)]
pub struct Stale<'a> {
    /// The properties it sends, nulls a replace leaves out already removed.
    pub sent: &'a Map<String, Value>,
    /// The properties it clears, a replace's left-out ones among them.
    pub cleared: &'a [String],
    pub fields: &'a ItemFields,
    pub current: &'a Map<String, Value>,
    pub current_fields: &'a ItemFields,
    pub ancestor: &'a Map<String, Value>,
    pub ancestor_fields: &'a ItemFields,
}

/// What a stale write collides with, and what it changes either way.
#[derive(Clone, Debug, PartialEq)]
pub struct Detection {
    /// Sorted. Empty where the write merges cleanly.
    pub conflicting: Vec<String>,
    pub colliding_item_fields: Vec<&'static str>,
    /// The item fields it genuinely changes: an echo is no change.
    pub changed_fields: ItemFields,
    /// The current properties with its genuine changes applied, where nothing
    /// collided.
    pub merged: Option<Map<String, Value>>,
}

/// How `conflict=auto` settles a collision.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub merged: Map<String, Value>,
    /// The fields the original keeps and the copy takes, sorted.
    pub keep_both: Vec<String>,
    pub strategies: BTreeMap<String, Strategy>,
}

/// Whether two values are one value to a reader: numbers by what they name
/// and objects whatever the order of their members.
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(name, a)| b.get(name).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

fn same_at(a: &Map<String, Value>, b: &Map<String, Value>, name: &str) -> bool {
    match (a.get(name), b.get(name)) {
        (Some(a), Some(b)) => same(a, b),
        (None, None) => true,
        _ => false,
    }
}

impl Stale<'_> {
    fn changes(&self, name: &str, value: &Value) -> bool {
        !self
            .ancestor
            .get(name)
            .is_some_and(|held| same(value, held))
    }

    /// A clear changes only a field the writer read and that is still there.
    fn clears(&self) -> impl Iterator<Item = &String> {
        self.cleared.iter().filter(|name| {
            self.ancestor.contains_key(*name)
                && !self.sent.contains_key(*name)
                && self.current.contains_key(*name)
        })
    }
}

/// Finds where a stale write collides with what landed since. A field sent
/// at the value the writer read is an echo: it changes nothing and collides
/// with nothing, or it would revert a value written since.
pub fn detect(stale: &Stale<'_>) -> Detection {
    let moved_since = |name: &str| !same_at(stale.current, stale.ancestor, name);
    let mut conflicting: Vec<String> = stale
        .sent
        .iter()
        .filter(|(name, value)| stale.changes(name, value))
        .map(|(name, _)| name)
        .chain(stale.clears())
        .filter(|name| moved_since(name))
        .cloned()
        .collect();
    let mut changed_fields = ItemFields::default();
    let mut colliding_item_fields = Vec::new();
    for name in ItemFields::NAMES {
        let Some(value) = stale.fields.get(name) else {
            continue;
        };
        let ancestor = stale.ancestor_fields.get(name);
        if Some(value) == ancestor {
            continue;
        }
        changed_fields.set(name, value.clone());
        if stale.current_fields.get(name) != ancestor {
            conflicting.push(name.to_string());
            colliding_item_fields.push(name);
        }
    }
    conflicting.sort();
    conflicting.dedup();
    let merged = conflicting.is_empty().then(|| {
        let mut merged = stale.current.clone();
        for (name, value) in stale.sent {
            if stale.changes(name, value) {
                merged.insert(name.clone(), value.clone());
            }
        }
        for name in stale.clears() {
            merged.shift_remove(name);
        }
        merged
    });
    Detection {
        conflicting,
        colliding_item_fields,
        changed_fields,
        merged,
    }
}

/// Settles a collision by `policy`. An item field has no strategy of its own:
/// a copy is a copy of properties, so the later writer takes it.
pub fn plan(stale: &Stale<'_>, detection: &Detection, policy: &MergePolicy) -> Plan {
    let mut merged = stale.current.clone();
    let mut keep_both = Vec::new();
    let mut strategies: BTreeMap<String, Strategy> = detection
        .colliding_item_fields
        .iter()
        .map(|name| (name.to_string(), Strategy::LastWriterWins))
        .collect();
    let mut settle = |name: &String, strategies: &mut BTreeMap<String, Strategy>| {
        if !detection.conflicting.contains(name) {
            return true;
        }
        let strategy = policy.strategy_for(name);
        strategies.insert(name.clone(), strategy);
        if strategy == Strategy::KeepBothCopies {
            keep_both.push(name.clone());
            return false;
        }
        true
    };
    for (name, value) in stale.sent {
        if stale.changes(name, value) && settle(name, &mut strategies) {
            merged.insert(name.clone(), value.clone());
        }
    }
    for name in stale.clears() {
        if settle(name, &mut strategies) {
            merged.shift_remove(name);
        }
    }
    keep_both.sort();
    Plan {
        merged,
        keep_both,
        strategies,
    }
}

/// What the copy holds: the item as it stands, with the writer's side of each
/// field the original kept.
pub fn copy_properties(stale: &Stale<'_>, keep_both: &[String]) -> Map<String, Value> {
    let mut properties = stale.current.clone();
    for name in keep_both {
        match stale.sent.get(name) {
            Some(value) => {
                properties.insert(name.clone(), value.clone());
            }
            None => {
                properties.shift_remove(name);
            }
        }
    }
    properties
}

/// The id of the copy one write makes, the same on every attempt of that
/// write, shaped as a UUIDv7.
pub fn copy_id(item_id: &str, base_version: i64, key: &str) -> String {
    let digest = Sha256::digest(format!("conflicted-copy\0{item_id}\0{base_version}\0{key}"));
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let variant = match digest[8] >> 4 & 3 {
        0 => '8',
        1 => '9',
        2 => 'a',
        _ => 'b',
    };
    format!(
        "{}-{}-7{}-{variant}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

/// How a named version stands against the one the item holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Precondition {
    /// The write stands on the current version, or names none.
    Current,
    /// The write stands on another version and may merge.
    Stale,
    /// The write asked for that version and no other.
    Refused,
}

pub fn precondition(held: i64, named: Option<i64>, exact: bool) -> Precondition {
    match named {
        Some(named) if named != held => {
            if exact {
                Precondition::Refused
            } else {
                Precondition::Stale
            }
        }
        _ => Precondition::Current,
    }
}

/// The properties a write at the current version leaves: `sent` laid over
/// `current`, or in its place under `replace`, a null there being a property
/// left out. A property keeps its place; a new one goes after.
pub fn laid_over(
    current: &Map<String, Value>,
    sent: &Map<String, Value>,
    replace: bool,
) -> Map<String, Value> {
    if replace {
        return sent
            .iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
    }
    let mut merged = current.clone();
    for (name, value) in sent {
        merged.insert(name.clone(), value.clone());
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    struct Case {
        name: &'static str,
        ancestor: Value,
        current: Value,
        sent: Value,
        cleared: &'static [&'static str],
        conflicting: &'static [&'static str],
        merged: Option<Value>,
    }

    #[test]
    fn a_stale_write_collides_only_where_both_sides_changed_a_field() {
        let cases = [
            Case {
                name: "a change to a field nobody else moved merges",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 1, "b": 2}),
                sent: json!({"a": 5}),
                cleared: &[],
                conflicting: &[],
                merged: Some(json!({"a": 5, "b": 2})),
            },
            Case {
                name: "an echo of the ancestor never reverts a change made since",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 1}),
                sent: json!({"a": 1, "b": 3}),
                cleared: &[],
                conflicting: &[],
                merged: Some(json!({"a": 2, "b": 3})),
            },
            Case {
                name: "both sides moving a field collide, even to one value",
                ancestor: json!({"a": 1}),
                current: json!({"a": 2}),
                sent: json!({"a": 2}),
                cleared: &[],
                conflicting: &["a"],
                merged: None,
            },
            Case {
                name: "a clear collides with a change to the same field",
                ancestor: json!({"a": 1}),
                current: json!({"a": 2}),
                sent: json!({}),
                cleared: &["a"],
                conflicting: &["a"],
                merged: None,
            },
            Case {
                name: "a clear of a field the ancestor lacked is no change",
                ancestor: json!({}),
                current: json!({"a": 2}),
                sent: json!({}),
                cleared: &["a"],
                conflicting: &[],
                merged: Some(json!({"a": 2})),
            },
            Case {
                name: "a clear of a field already gone is no change",
                ancestor: json!({"a": 1}),
                current: json!({}),
                sent: json!({}),
                cleared: &["a"],
                conflicting: &[],
                merged: Some(json!({})),
            },
            Case {
                name: "a value that differs only in how it is written is an echo",
                ancestor: json!({"a": 1, "o": {"x": 1, "y": 2}}),
                current: json!({"a": 2, "o": {"y": 3, "x": 1}}),
                sent: json!({"a": 1.0, "o": {"y": 2, "x": 1}}),
                cleared: &[],
                conflicting: &[],
                merged: Some(json!({"a": 2, "o": {"y": 3, "x": 1}})),
            },
            Case {
                name: "the list of collisions is sorted",
                ancestor: json!({"b": 1, "a": 1}),
                current: json!({"b": 2, "a": 2}),
                sent: json!({"b": 3, "a": 3}),
                cleared: &[],
                conflicting: &["a", "b"],
                merged: None,
            },
        ];
        for case in cases {
            let (ancestor, current, sent) = (map(case.ancestor), map(case.current), map(case.sent));
            let cleared: Vec<String> = case.cleared.iter().map(|s| s.to_string()).collect();
            let none = ItemFields::default();
            let found = detect(&Stale {
                sent: &sent,
                cleared: &cleared,
                fields: &none,
                current: &current,
                current_fields: &none,
                ancestor: &ancestor,
                ancestor_fields: &none,
            });
            assert_eq!(found.conflicting, case.conflicting, "{}", case.name);
            assert_eq!(found.merged, case.merged.map(map), "{}", case.name);
        }
    }

    #[test]
    fn an_item_field_collides_on_the_same_rule_and_an_echo_is_no_change() {
        let ancestor = ItemFields {
            tier: Some("library".into()),
            occurred_at: Some("t1".into()),
            source_id: None,
        };
        let current = ItemFields {
            tier: Some("feed".into()),
            ..ancestor.clone()
        };
        let written = ItemFields {
            tier: Some("library".into()),
            occurred_at: Some("t2".into()),
            source_id: None,
        };
        let empty = Map::new();
        let found = detect(&Stale {
            sent: &empty,
            cleared: &[],
            fields: &written,
            current: &empty,
            current_fields: &current,
            ancestor: &empty,
            ancestor_fields: &ancestor,
        });
        assert!(found.conflicting.is_empty());
        assert_eq!(
            found.changed_fields,
            ItemFields {
                occurred_at: Some("t2".into()),
                ..ItemFields::default()
            }
        );
        let written = ItemFields {
            tier: Some("archive".into()),
            ..ItemFields::default()
        };
        let found = detect(&Stale {
            sent: &empty,
            cleared: &[],
            fields: &written,
            current: &empty,
            current_fields: &current,
            ancestor: &empty,
            ancestor_fields: &ancestor,
        });
        assert_eq!(found.conflicting, ["tier"]);
        assert_eq!(found.colliding_item_fields, ["tier"]);
        assert!(found.merged.is_none());
    }

    struct PlanCase {
        name: &'static str,
        ancestor: Value,
        current: Value,
        sent: Value,
        cleared: &'static [&'static str],
        policy: Value,
        merged: Value,
        keep_both: &'static [&'static str],
        copy: Value,
    }

    #[test]
    fn the_merge_plan_settles_each_collision_by_the_policy() {
        let cases = [
            PlanCase {
                name: "the later writer wins with no policy, and clean changes land",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 1}),
                sent: json!({"a": 3, "b": 4}),
                cleared: &[],
                policy: json!({}),
                merged: json!({"a": 3, "b": 4}),
                keep_both: &[],
                copy: json!({"a": 2, "b": 1}),
            },
            PlanCase {
                name: "keeping both leaves the original and gives the copy the value",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 1}),
                sent: json!({"a": 3, "b": 4}),
                cleared: &[],
                policy: json!({"fields": {"a": "keep_both_copies"}}),
                merged: json!({"a": 2, "b": 4}),
                keep_both: &["a"],
                copy: json!({"a": 3, "b": 1}),
            },
            PlanCase {
                name: "a field's own strategy beats the default",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 2}),
                sent: json!({"a": 3, "b": 3}),
                cleared: &[],
                policy: json!({"default": "keep_both_copies", "fields": {"b": "last_writer_wins"}}),
                merged: json!({"a": 2, "b": 3}),
                keep_both: &["a"],
                copy: json!({"a": 3, "b": 2}),
            },
            PlanCase {
                name: "a colliding clear under the later writer removes the field",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 1}),
                sent: json!({}),
                cleared: &["a"],
                policy: json!({}),
                merged: json!({"b": 1}),
                keep_both: &[],
                copy: json!({"a": 2, "b": 1}),
            },
            PlanCase {
                name: "a colliding clear keeping both takes the field from the copy",
                ancestor: json!({"a": 1, "b": 1}),
                current: json!({"a": 2, "b": 1}),
                sent: json!({}),
                cleared: &["a"],
                policy: json!({"default": "keep_both_copies"}),
                merged: json!({"a": 2, "b": 1}),
                keep_both: &["a"],
                copy: json!({"b": 1}),
            },
            PlanCase {
                name: "a clean clear lands beside a collision and keeps its place",
                ancestor: json!({"a": 1, "b": 1, "c": 1}),
                current: json!({"a": 1, "b": 2, "c": 1}),
                sent: json!({"b": 3}),
                cleared: &["a"],
                policy: json!({}),
                merged: json!({"b": 3, "c": 1}),
                keep_both: &[],
                copy: json!({"a": 1, "b": 2, "c": 1}),
            },
        ];
        for case in cases {
            let (ancestor, current, sent) = (map(case.ancestor), map(case.current), map(case.sent));
            let cleared: Vec<String> = case.cleared.iter().map(|s| s.to_string()).collect();
            let none = ItemFields::default();
            let stale = Stale {
                sent: &sent,
                cleared: &cleared,
                fields: &none,
                current: &current,
                current_fields: &none,
                ancestor: &ancestor,
                ancestor_fields: &none,
            };
            let found = detect(&stale);
            let policy = MergePolicy::default().laid_over_by(&case.policy);
            let settled = plan(&stale, &found, &policy);
            assert_eq!(settled.merged, map(case.merged), "{}", case.name);
            assert_eq!(settled.keep_both, case.keep_both, "{}", case.name);
            assert_eq!(
                copy_properties(&stale, &settled.keep_both),
                map(case.copy),
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn a_merge_keeps_each_field_in_its_place() {
        let ancestor = map(json!({"a": 1, "b": 1, "c": 1}));
        let current = map(json!({"a": 1, "b": 2, "c": 1}));
        let sent = map(json!({"z": 1, "a": 9}));
        let cleared = vec!["b".to_string()];
        let none = ItemFields::default();
        let clean = detect(&Stale {
            sent: &sent,
            cleared: &[],
            fields: &none,
            current: &current,
            current_fields: &none,
            ancestor: &ancestor,
            ancestor_fields: &none,
        });
        let names: Vec<&str> = clean
            .merged
            .iter()
            .flat_map(|merged| merged.keys())
            .map(String::as_str)
            .collect();
        assert_eq!(names, ["a", "b", "c", "z"]);
        let stale = Stale {
            sent: &sent,
            cleared: &cleared,
            fields: &none,
            current: &current,
            current_fields: &none,
            ancestor: &ancestor,
            ancestor_fields: &none,
        };
        let settled = plan(&stale, &detect(&stale), &MergePolicy::default());
        let names: Vec<&str> = settled.merged.keys().map(String::as_str).collect();
        assert_eq!(names, ["a", "c", "z"]);
    }

    #[test]
    fn a_copy_id_is_one_uuid_for_one_write_and_another_for_any_other() {
        let id = copy_id("0190a000-0000-7000-8000-000000000000", 3, "key");
        assert_eq!(
            id,
            copy_id("0190a000-0000-7000-8000-000000000000", 3, "key")
        );
        assert_ne!(
            id,
            copy_id("0190a000-0000-7000-8000-000000000000", 4, "key")
        );
        assert_ne!(
            id,
            copy_id("0190a000-0000-7000-8000-000000000000", 3, "yek")
        );
        assert!(crate::validation::id("id", &id).is_ok(), "{id}");
    }

    #[test]
    fn a_version_precondition_reads_as_the_write_asks() {
        for (held, named, exact, expected) in [
            (3, Some(3), false, Precondition::Current),
            (3, Some(3), true, Precondition::Current),
            (3, None, false, Precondition::Current),
            (3, None, true, Precondition::Current),
            (3, Some(2), false, Precondition::Stale),
            (3, Some(2), true, Precondition::Refused),
            (3, Some(9), false, Precondition::Stale),
            (3, Some(9), true, Precondition::Refused),
        ] {
            assert_eq!(precondition(held, named, exact), expected);
        }
    }
}
