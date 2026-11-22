//! A plugin connector's section and the owner's mapping of what each of its kinds brings.
//!
//! The server judges a mapping by these rules when it is saved, and the command line reads the
//! same shape, so the two never disagree on what a mapping holds.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::catalog::Catalog;
use crate::schema::Problem;

pub const TIERS: [&str; 2] = ["feed", "library"];
pub const DEFAULT_TIER: &str = "feed";
const DIRECTIONS: [&str; 3] = ["in", "out", "both"];
const ENTRY_MEMBERS: [&str; 5] = [
    "enabled",
    "target_type",
    "tier",
    "status_overrides",
    "fields",
];
/// A plugin's `default_mapping` sets only these: the type map alone decides the kind's own type.
const DEFAULT_MEMBERS: [&str; 3] = ["tier", "status_overrides", "fields"];
const TEXT_FIELD: &str = "string";

#[derive(Clone, Debug, PartialEq)]
pub struct Kind {
    pub name: String,
    pub own_type: String,
    pub direction: String,
    /// The kind's entry where no mapping names it, its fields only where `default_mapping` names them.
    default: Entry,
    default_fields: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Connector {
    pub source: String,
    pub kinds: Vec<Kind>,
}

impl Connector {
    pub fn kind(&self, name: &str) -> Option<&Kind> {
        self.kinds.iter().find(|kind| kind.name == name)
    }
}

fn own_entry(own_type: &str) -> Entry {
    Entry {
        enabled: true,
        target_type: own_type.to_string(),
        tier: DEFAULT_TIER.to_string(),
        status_overrides: BTreeMap::new(),
        fields: BTreeMap::new(),
    }
}

/// A kind's `default_mapping` over its own type at the feed, its faults named under `at`.
pub(crate) fn read_default(
    value: Option<&Value>,
    own_type: &str,
    at: &str,
    problems: &mut Vec<Problem>,
) -> Option<(Entry, bool)> {
    match value {
        None | Some(Value::Null) => Some((own_entry(own_type), false)),
        Some(value) => {
            let fields = value.get("fields").is_some();
            read_entry(value, own_entry(own_type), at, &DEFAULT_MEMBERS, problems)
                .map(|entry| (entry, fields))
        }
    }
}

/// The connector a bundle's `connector` object names, or none where it does not read as one.
pub fn connector_of(bundle: &Map<String, Value>) -> Option<Connector> {
    let section = bundle.get("connector")?.as_object()?;
    let source = section.get("source")?.as_str()?;
    if source.is_empty() {
        return None;
    }
    let mut kinds: Vec<Kind> = Vec::new();
    for held in section.get("kinds")?.as_array()? {
        let held = held.as_object()?;
        let name = held.get("name")?.as_str()?;
        let own_type = held.get("type")?.as_str()?;
        let direction = held.get("direction")?.as_str()?;
        if name.is_empty() || !DIRECTIONS.contains(&direction) {
            return None;
        }
        if kinds.iter().any(|kind| kind.name == name) {
            return None;
        }
        let (default, default_fields) =
            read_default(held.get("default_mapping"), own_type, "", &mut Vec::new())?;
        kinds.push(Kind {
            name: name.to_string(),
            own_type: own_type.to_string(),
            direction: direction.to_string(),
            default,
            default_fields,
        });
    }
    Some(Connector {
        source: source.to_string(),
        kinds,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    From(String),
    Fixed(Value),
    Template(String),
}

impl Field {
    fn to_json(&self) -> Value {
        match self {
            Field::From(name) => json!({ "from": name }),
            Field::Fixed(value) => json!({ "fixed": value }),
            Field::Template(text) => json!({ "template": text }),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub enabled: bool,
    pub target_type: String,
    pub tier: String,
    pub status_overrides: BTreeMap<String, String>,
    pub fields: BTreeMap<String, Field>,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        let fields: Map<String, Value> = self
            .fields
            .iter()
            .map(|(name, field)| (name.clone(), field.to_json()))
            .collect();
        json!({
            "enabled": self.enabled,
            "target_type": self.target_type,
            "tier": self.tier,
            "status_overrides": self.status_overrides,
            "fields": fields,
        })
    }
}

pub type Kinds = BTreeMap<String, Entry>;

pub fn kinds_json(kinds: &Kinds) -> Value {
    Value::Object(
        kinds
            .iter()
            .map(|(name, entry)| (name.clone(), entry.to_json()))
            .collect(),
    )
}

fn problem(path: &str, message: impl Into<String>) -> Problem {
    Problem {
        path: path.to_string(),
        code: "invalid",
        message: message.into(),
        hint: None,
    }
}

/// Each field the target declares that the kind's own type also declares, taken from it.
pub(crate) fn identity(
    own_type: &str,
    target_type: &str,
    catalog: &Catalog,
) -> BTreeMap<String, Field> {
    let own = catalog.resolved(own_type).unwrap_or_default();
    catalog
        .resolved(target_type)
        .unwrap_or_default()
        .keys()
        .filter(|name| own.contains_key(*name))
        .map(|name| (name.clone(), Field::From(name.clone())))
        .collect()
}

/// What a kind holds where no mapping names it: its `default_mapping` over the plugin's own type
/// at the feed. Fields it does not name are those both types declare, which only `catalog` knows;
/// without one they are left empty, as the reach and the tier never read them.
pub fn default_entry(kind: &Kind, catalog: Option<&Catalog>) -> Entry {
    let mut entry = kind.default.clone();
    if !kind.default_fields {
        entry.fields = catalog
            .map(|catalog| identity(&kind.own_type, &entry.target_type, catalog))
            .unwrap_or_default();
    }
    entry
}

/// One kind's entry, each member it leaves out taken from `base`, its faults named under `at`.
fn read_entry(
    value: &Value,
    base: Entry,
    at: &str,
    members: &[&str],
    problems: &mut Vec<Problem>,
) -> Option<Entry> {
    let path = |member: &str| {
        if at.is_empty() {
            member.to_string()
        } else {
            format!("{at}.{member}")
        }
    };
    let Some(held) = value.as_object() else {
        problems.push(problem(at, "Must be an object."));
        return None;
    };
    let before = problems.len();
    for member in held.keys() {
        if !members.contains(&member.as_str()) {
            problems.push(problem(
                &path(member),
                if ENTRY_MEMBERS.contains(&member.as_str()) {
                    "Is not set by a plugin's default mapping."
                } else {
                    "Is not a member of a kind's mapping."
                },
            ));
        }
    }
    let held: Map<String, Value> = held
        .iter()
        .filter(|(member, _)| members.contains(&member.as_str()))
        .map(|(member, value)| (member.clone(), value.clone()))
        .collect();
    let mut entry = base;
    match held.get("enabled") {
        None => {}
        Some(Value::Bool(enabled)) => entry.enabled = *enabled,
        Some(_) => problems.push(problem(&path("enabled"), "Must be true or false.")),
    }
    match held.get("target_type") {
        None => {}
        Some(Value::String(target)) => entry.target_type = target.clone(),
        Some(_) => problems.push(problem(&path("target_type"), "Must be a type identifier.")),
    }
    match held.get("tier").map(Value::as_str) {
        None => {}
        Some(Some(tier)) if TIERS.contains(&tier) => entry.tier = tier.to_string(),
        Some(_) => problems.push(problem(&path("tier"), "Must be feed or library.")),
    }
    match held.get("status_overrides") {
        None => {}
        Some(Value::Object(overrides)) => {
            let mut read = BTreeMap::new();
            for (word, to) in overrides {
                match to.as_str() {
                    Some(to) => {
                        read.insert(word.clone(), to.to_string());
                    }
                    None => problems.push(problem(
                        &path(&format!("status_overrides.{word}")),
                        "Must be a status word.",
                    )),
                }
            }
            entry.status_overrides = read;
        }
        Some(_) => problems.push(problem(
            &path("status_overrides"),
            "Must be an object of status words.",
        )),
    }
    match held.get("fields") {
        None => {}
        Some(Value::Object(fields)) => {
            let mut read = BTreeMap::new();
            for (name, field) in fields {
                match field_of(field) {
                    Some(field) => {
                        read.insert(name.clone(), field);
                    }
                    None => problems.push(problem(
                        &path(&format!("fields.{name}")),
                        "Must be an object holding exactly one of from, fixed or template.",
                    )),
                }
            }
            entry.fields = read;
        }
        Some(_) => problems.push(problem(&path("fields"), "Must be an object.")),
    }
    (problems.len() == before).then_some(entry)
}

fn field_of(value: &Value) -> Option<Field> {
    let held = value.as_object()?;
    if held.len() != 1 {
        return None;
    }
    let (key, value) = held.iter().next()?;
    match (key.as_str(), value) {
        ("from", Value::String(name)) => Some(Field::From(name.clone())),
        ("fixed", value) => Some(Field::Fixed(value.clone())),
        ("template", Value::String(text)) => Some(Field::Template(text.clone())),
        _ => None,
    }
}

/// A mapping as `PUT` sends it: its `version` and an entry for every kind, a kind or member it
/// leaves out taken from the default. Judged only for its shape.
pub fn read_body(
    body: &Value,
    connector: &Connector,
    catalog: &Catalog,
) -> Result<(i64, Kinds), Vec<Problem>> {
    let mut problems = Vec::new();
    let Some(held) = body.as_object() else {
        return Err(vec![problem(
            "",
            "Must be an object holding version and kinds.",
        )]);
    };
    for member in held.keys() {
        if member != "version" && member != "kinds" {
            problems.push(problem(member, "Is not a member of a mapping."));
        }
    }
    let version = held.get("version").and_then(Value::as_i64);
    if version.is_none_or(|version| version < 0) {
        problems.push(problem(
            "version",
            "Must be the version of the mapping read.",
        ));
    }
    let empty = Map::new();
    let named = match held.get("kinds") {
        Some(Value::Object(named)) => named,
        _ => {
            problems.push(problem("kinds", "Must be an object keyed by kind."));
            &empty
        }
    };
    for name in named.keys() {
        if connector.kind(name).is_none() {
            problems.push(problem(
                &format!("kinds.{name}"),
                "Is not a kind this connector brings.",
            ));
        }
    }
    let mut kinds = Kinds::new();
    for kind in &connector.kinds {
        let default = default_entry(kind, Some(catalog));
        let entry = match named.get(&kind.name) {
            None => Some(default),
            Some(value) => read_entry(
                value,
                default,
                &format!("kinds.{}", kind.name),
                &ENTRY_MEMBERS,
                &mut problems,
            ),
        };
        if let Some(entry) = entry {
            kinds.insert(kind.name.clone(), entry);
        }
    }
    match version {
        Some(version) if problems.is_empty() => Ok((version, kinds)),
        _ => Err(problems),
    }
}

/// A stored mapping's entries, by kind. `None` where it does not read.
pub fn stored(value: &Value) -> Option<Kinds> {
    let held = value.as_object()?;
    let mut kinds = Kinds::new();
    for (name, value) in held {
        let mut problems = Vec::new();
        let base = Entry {
            enabled: true,
            target_type: String::new(),
            tier: DEFAULT_TIER.to_string(),
            status_overrides: BTreeMap::new(),
            fields: BTreeMap::new(),
        };
        let entry = read_entry(value, base, name, &ENTRY_MEMBERS, &mut problems)?;
        if entry.target_type.is_empty() {
            return None;
        }
        kinds.insert(name.clone(), entry);
    }
    Some(kinds)
}

/// The mapping in force: the stored entry of each kind the connector brings, else its default.
/// The answer, the tier and the reach all read it here.
pub fn in_force(stored: Option<&Kinds>, connector: &Connector, catalog: Option<&Catalog>) -> Kinds {
    connector
        .kinds
        .iter()
        .map(|kind| {
            let entry = stored
                .and_then(|stored| stored.get(&kind.name))
                .cloned()
                .unwrap_or_else(|| default_entry(kind, catalog));
            (kind.name.clone(), entry)
        })
        .collect()
}

fn field_type(definition: &Value) -> Option<&str> {
    definition.get("type").and_then(Value::as_str)
}

/// Each enabled kind judged against the types as `catalog` holds them. `may_write` says whether
/// the caller saving the mapping may write a type.
pub fn judge(
    kinds: &Kinds,
    connector: &Connector,
    catalog: &Catalog,
    may_write: impl Fn(&str) -> bool,
) -> Vec<Problem> {
    let mut problems = Vec::new();
    for kind in &connector.kinds {
        if let Some(entry) = kinds.get(&kind.name).filter(|entry| entry.enabled) {
            let at = format!("kinds.{}", kind.name);
            judge_entry(
                &kind.own_type,
                entry,
                &at,
                catalog,
                &may_write,
                &mut problems,
            );
        }
    }
    problems
}

/// One enabled kind's entry, its faults named under `at`.
pub(crate) fn judge_entry(
    own_type: &str,
    entry: &Entry,
    at: &str,
    catalog: &Catalog,
    may_write: &impl Fn(&str) -> bool,
    problems: &mut Vec<Problem>,
) {
    let target = entry.target_type.as_str();
    let reserved = target.split('.').next() == Some("system");
    if reserved || !catalog.known(target) || !may_write(target) {
        problems.push(problem(
            &format!("{at}.target_type"),
            "Must be a registered type you may write, outside system.",
        ));
        return;
    }
    let own = catalog.resolved(own_type).unwrap_or_default();
    let fields = catalog.resolved(target).unwrap_or_default();
    for (name, field) in &entry.fields {
        let path = format!("{at}.fields.{name}");
        let Some(definition) = fields.get(name) else {
            problems.push(problem(
                &path,
                format!("{target} declares no field {name}."),
            ));
            continue;
        };
        match field {
            Field::From(from) if !own.contains_key(from) => problems.push(problem(
                &format!("{path}.from"),
                format!("{own_type} declares no field {from}."),
            )),
            Field::Fixed(value) => {
                let mut single = Map::new();
                single.insert(name.clone(), value.clone());
                if let Err(refused) = catalog.validate_properties(target, &single, false) {
                    problems.push(problem(&format!("{path}.fixed"), refused.message));
                }
            }
            Field::Template(_) if field_type(definition) != Some(TEXT_FIELD) => {
                problems.push(problem(
                    &format!("{path}.template"),
                    "A template fills only a field of type string.",
                ));
            }
            _ => {}
        }
    }
    for (name, definition) in &fields {
        let required = definition.get("required").and_then(Value::as_bool) == Some(true);
        let filled = match entry.fields.get(name) {
            Some(Field::From(_) | Field::Fixed(_)) => true,
            Some(Field::Template(_)) => field_type(definition) == Some(TEXT_FIELD),
            None => false,
        };
        if required
            && !filled
            && !problems
                .iter()
                .any(|held| held.path.starts_with(&format!("{at}.fields.{name}")))
        {
            problems.push(problem(
                &format!("{at}.fields.{name}"),
                format!("{target} requires {name}; give it a field or a fixed value."),
            ));
        }
    }
    let own_status = catalog.status_field(own_type);
    let target_status = catalog.status_field(target);
    for (word, to) in &entry.status_overrides {
        let declares = |status: &Option<crate::catalog::StatusField>, word: &str| {
            status
                .as_ref()
                .is_some_and(|status| status.group_of(&json!(word)).is_some())
        };
        if !declares(&own_status, word) || !declares(&target_status, to) {
            problems.push(problem(
                &format!("{at}.status_overrides.{word}"),
                format!(
                    "Maps a status word of {own_type} to one of {target}; one of them declares no such word."
                ),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connector() -> Connector {
        connector_of(
            json!({ "connector": { "source": "trk", "kinds": [
                { "name": "issue", "type": "trk.issue", "direction": "in" },
                { "name": "note", "type": "trk.note", "direction": "both",
                  "default_mapping": { "tier": "library" } },
            ] } })
            .as_object()
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn a_connector_section_reads_only_whole() {
        assert_eq!(connector().kinds.len(), 2);
        let section =
            |connector: Value| connector_of(json!({ "connector": connector }).as_object().unwrap());
        assert!(section(json!({ "source": "", "kinds": [] })).is_none());
        assert!(section(json!({ "source": "s", "kinds": [{ "name": "a", "type": "t", "direction": "sideways" }] })).is_none());
        assert!(
            section(json!({ "source": "s", "kinds": [
            { "name": "a", "type": "t", "direction": "in" },
            { "name": "a", "type": "u", "direction": "in" },
        ] }))
            .is_none()
        );
        assert!(section(json!({ "anything": [1] })).is_none());
    }

    #[test]
    fn a_kind_no_mapping_names_takes_its_default_mapping_over_its_own_type_at_the_feed() {
        let kinds = in_force(None, &connector(), None);
        let issue = &kinds["issue"];
        assert_eq!(
            (
                issue.enabled,
                issue.target_type.as_str(),
                issue.tier.as_str()
            ),
            (true, "trk.issue", "feed")
        );
        let note = &kinds["note"];
        assert_eq!(
            (note.enabled, note.target_type.as_str(), note.tier.as_str()),
            (true, "trk.note", "library")
        );
    }

    #[test]
    fn a_body_names_each_fault_of_its_shape() {
        let catalog = Catalog::empty();
        let faults = read_body(
            &json!({ "version": 0, "kinds": {
                "issue": { "tier": "archive", "fields": { "a": { "from": "x", "fixed": 1 } } },
                "ghost": {},
            } }),
            &connector(),
            &catalog,
        )
        .unwrap_err();
        let mut paths: Vec<&str> = faults.iter().map(|fault| fault.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            ["kinds.ghost", "kinds.issue.fields.a", "kinds.issue.tier"]
        );
    }

    #[test]
    fn a_stored_mapping_reads_back_as_written() {
        let catalog = Catalog::empty();
        let (_, kinds) = read_body(
            &json!({ "version": 3, "kinds": { "issue": { "target_type": "core.task", "fields": { "title": { "template": "{{ title }}" } } } } }),
            &connector(),
            &catalog,
        )
        .unwrap();
        assert_eq!(stored(&kinds_json(&kinds)), Some(kinds));
        assert_eq!(stored(&json!({ "issue": { "tier": "x" } })), None);
    }
}
