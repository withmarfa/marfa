//! A type registration: every fault it has, and the form the registry stores.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::compat::{describe_compatibility_conflict, inherited_shape_conflicts};
use super::field::{Shape, label_issue, normalize_field, validate_field_shape};
use super::registry::Ancestry;
use super::tables::judge_tables;
use super::{
    Issue, MAX_FEED_DAYS, MERGE_STRATEGIES, Obj, REFUSED_TYPE_KEYS, Registry, TYPE_ROLES, as_obj,
    describe, icon_issue, kind, names, number, positive_integer, required, text, unread_keys,
    whole,
};
use crate::builtin;
use crate::catalog::merge_field_definition;
use crate::grammar;

const SEARCHED_NAMES: [&str; 4] = ["title", "body", "description", "name"];

#[derive(Default)]
struct Ordered(Vec<(String, Obj)>);

impl Ordered {
    fn set(&mut self, name: &str, definition: Obj) {
        match self.0.iter_mut().find(|(held, _)| held == name) {
            Some((_, slot)) => *slot = definition,
            None => self.0.push((name.to_string(), definition)),
        }
    }
}

/// The registry as it stands, and as it would stand once the type is replaced.
struct Replaced<'a> {
    before: &'a Registry,
    after: Registry,
    stored: Obj,
}

impl<'a> Replaced<'a> {
    fn new(
        obj: &Obj,
        fields: &Obj,
        required_names: &[String],
        before: &'a Registry,
        ancestry: &Ancestry,
    ) -> Replaced<'a> {
        let stored = stored_fields(fields, required_names, ancestry);
        let mut row = Obj::new();
        for key in ["id", "parent"] {
            if let Some(value) = obj.get(key) {
                row.insert(key.into(), value.clone());
            }
        }
        row.insert("fields".into(), Value::Object(stored.clone()));
        Replaced {
            before,
            after: before.with(row),
            stored,
        }
    }
}

fn merged(above: Option<&Obj>, own: &Obj) -> Obj {
    let above = above.map(|a| Value::Object(a.clone()));
    match merge_field_definition(above.as_ref(), &Value::Object(own.clone())) {
        Value::Object(merged) => merged,
        _ => own.clone(),
    }
}

fn is_thumbnail(definition: Option<&Value>) -> bool {
    as_obj(definition).is_some_and(|raw| {
        text(raw, "type") == Some("thumbnail") || text(raw, "format") == Some("thumbnail")
    })
}

fn required_names(input: &Obj) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !names.iter().any(|held| held == name) {
            names.push(name.to_string());
        }
    };
    for name in input
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(name) = name.as_str() {
            add(name);
        }
    }
    for (name, definition) in as_obj(input.get("fields")).into_iter().flatten() {
        if as_obj(Some(definition)).is_some_and(required) {
            add(name);
        }
    }
    names
}

pub fn validate_type(input: &Value, registry: &Registry) -> Result<Obj, Vec<Issue>> {
    let Some(obj) = input.as_object() else {
        return Err(vec![Issue::new(
            "_root",
            "a JSON object describing the type",
            describe(Some(input)),
            "A type schema is an object with at least `id` and `fields`.",
        )]);
    };
    let mut errors: Vec<Issue> = Vec::new();
    let id = obj.get("id").and_then(Value::as_str);
    match id {
        None => errors.push(Issue::new(
            "id",
            "a dot-separated type identifier, e.g. acme.deal",
            describe(obj.get("id")),
            "Every type needs an id under a namespace you own.",
        )),
        Some(id) if !grammar::type_id(id).unwrap_or(false) => errors.push(Issue::new(
            "id",
            "an identifier matching the namespace grammar: core.<type>, system.<type>, app.<app-name>.<type>, user.<type>, or <publisher>.<type>",
            describe(obj.get("id")),
            "Segments are lowercase, separated by dots. Forward slashes and reserved-root collisions are rejected.",
        )),
        Some(_) => {}
    }
    label_issue(
        "label",
        obj.get("label"),
        &mut errors,
        "label is the human-facing name. Omit it to derive one from the id.",
    );
    label_issue(
        "plural",
        obj.get("plural"),
        &mut errors,
        "The name for more than one item, such as People. Omit it to make one from the label.",
    );
    if obj.get("description").is_some_and(|d| !d.is_string()) {
        errors.push(Issue::new(
            "description",
            "a string, or nothing",
            describe(obj.get("description")),
            "description is rendered on the consent screen and in the type catalog.",
        ));
    }
    if obj.get("parent").is_some_and(|p| !p.is_string()) {
        errors.push(Issue::new(
            "parent",
            "a type identifier string, or nothing",
            describe(obj.get("parent")),
            "Set parent to inherit an existing type's fields, or omit it for a standalone type.",
        ));
    }
    if obj.contains_key("version")
        && !number(obj.get("version")).is_some_and(|n| whole(n) && n >= 0.0)
    {
        errors.push(Issue::new(
            "version",
            "a non-negative integer",
            describe(obj.get("version")),
            "Versions are integers from 0. Omit the field to default to 0.",
        ));
    }
    match obj.get("required") {
        None => {}
        Some(Value::Array(entries)) => {
            for entry in entries.iter().filter(|e| !e.is_string()) {
                errors.push(Issue::new(
                    "required",
                    "every entry to name a field",
                    describe(Some(entry)),
                    "List field names as strings.",
                ));
            }
        }
        Some(other) => errors.push(Issue::new(
            "required",
            "an array of field names, or nothing",
            describe(Some(other)),
            "Required-ness may be declared either as a top-level [\"title\"] array or as required: true on the field.",
        )),
    }
    for forbidden in REFUSED_TYPE_KEYS {
        if obj.contains_key(forbidden) {
            errors.push(Issue::new(
                forbidden,
                format!("no `{forbidden}` key"),
                format!("a `{forbidden}` declaration"),
                "Lifecycle is universal (active / archived / trashed) and is not declared per type. Remove the key.",
            ));
        }
    }
    errors.extend(unread_keys(obj));
    let fields = as_obj(obj.get("fields"));
    match fields {
        None => errors.push(Issue::new(
            "fields",
            "an object mapping field names to definitions",
            describe(obj.get("fields")),
            "Declare at least one field, e.g. { \"title\": { \"type\": \"string\" } }.",
        )),
        Some(fields) => {
            let reserved = builtin::reserved_field_names().unwrap_or_default();
            for name in fields.keys().filter(|name| reserved.contains(name)) {
                errors.push(
                    Issue::new(
                        format!("fields.{name}"),
                        "a property name that is not a first-class Item field",
                        format!("\"{name}\", which is a first-class Item field"),
                        format!("Set the Item field \"{name}\" directly instead, or rename this property to something type-specific."),
                    )
                    .coded("property_shadows_field"),
                );
            }
        }
    }
    let required_names = required_names(obj);
    let parent = obj
        .get("parent")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let lineage = registry.lineage(obj);
    let ancestry = &lineage.ancestry;
    let descendants = &lineage.descendants;
    let replaced = fields
        .filter(|_| !descendants.is_empty())
        .map(|fields| Replaced::new(obj, fields, &required_names, registry, ancestry));
    if let Some(fields) = fields {
        for (name, definition) in fields {
            let inherits_status = ancestry
                .get(name)
                .is_some_and(|held| kind(&held.definition) == Some("status"));
            validate_field_shape(
                name,
                definition,
                &mut errors,
                &Shape {
                    inherits_status,
                    path: None,
                },
            );
        }
        let own: Vec<(&str, Obj)> = fields
            .iter()
            .filter_map(|(name, def)| {
                Some((
                    name.as_str(),
                    normalize_field(def.as_object()?, Some(required_names.contains(name))),
                ))
            })
            .collect();
        for conflict in inherited_shape_conflicts(own.iter().map(|(n, d)| (*n, d)), ancestry) {
            errors.push(
                Issue::new(
                    format!("fields.{}.{}", conflict.field, conflict.attribute),
                    format!("{}, inherited from \"{}\"", conflict.inherited, conflict.owner),
                    conflict.declared,
                    format!("A child type may sharpen an inherited field's description or tighten it to required, but not change its shape. Rename the property, or change \"{}\" instead.", conflict.owner),
                )
                .coded("inheritance_violation"),
            );
        }
    }
    if let Some(fields) = fields {
        validate_status_fields(
            id,
            fields,
            ancestry,
            descendants,
            replaced.as_ref(),
            &mut errors,
        );
        if let Some(replaced) = &replaced {
            validate_descendant_shapes(replaced, descendants, &mut errors);
        }
        validate_descendant_links(
            id,
            fields,
            &required_names,
            ancestry,
            descendants,
            registry,
            &mut errors,
        );
    }
    let tables = judge_tables(obj, &lineage, &|held| {
        registry.contains(held) || id == Some(held)
    })
    .unwrap_or_else(|issues| {
        errors.extend(issues);
        Obj::new()
    });
    let visible: HashSet<&str> = fields
        .into_iter()
        .flat_map(|f| f.keys().map(String::as_str))
        .chain(ancestry.names())
        .collect();
    if let Some(fields) = fields {
        validate_thumbnails(
            fields,
            ancestry,
            descendants,
            replaced.as_ref(),
            &mut errors,
        );
    }
    validate_descendant_members(id, &visible, descendants, registry, &mut errors);
    for name in &required_names {
        if !visible.contains(name.as_str()) {
            errors.push(Issue::new(
                "required",
                "every required name to match a declared or inherited field",
                format!("\"{name}\", which this type does not declare"),
                format!("Add \"{name}\" to fields, or drop it from required."),
            ));
        }
    }
    validate_roles(obj, &mut errors);
    let thumbnails = thumbnail_names(fields, ancestry);
    validate_display_hints(obj, &visible, &thumbnails, &mut errors);
    validate_link_field(obj, fields, &required_names, ancestry, &mut errors);
    validate_version_policy(obj, &mut errors);
    validate_merge_policy(obj, &visible, &mut errors);
    validate_retention_policy(obj, &mut errors);
    validate_compatible_with(
        obj,
        fields,
        &required_names,
        ancestry,
        registry,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(stored_form(
        obj,
        fields,
        &required_names,
        ancestry,
        parent,
        tables,
    ))
}

/// What each declared type holds that a registration would refuse against the types above it, as (id, what it declares): a field in another shape, a status word a type above already gives, a second thumbnail.
pub fn declared_conflicts(types: &[Value]) -> Vec<(String, String)> {
    let mut held = Registry::new(
        builtin::shipped_types()
            .map(<[Obj]>::to_vec)
            .unwrap_or_default(),
    );
    let mut waiting: Vec<(&str, &Obj)> = types
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|row| Some((text(row, "id")?, row)))
        .collect();
    let mut declared: Vec<(String, Option<String>, Obj)> = Vec::new();
    while !waiting.is_empty() {
        let (ready, later): (Vec<_>, Vec<_>) = waiting.iter().copied().partition(|(_, row)| {
            text(row, "parent").is_none_or(|parent| !waiting.iter().any(|(id, _)| *id == parent))
        });
        let (ready, later) = if ready.is_empty() {
            (later, ready)
        } else {
            (ready, later)
        };
        for (id, row) in ready {
            let parent = text(row, "parent").map(str::to_string);
            let ancestry = parent
                .as_deref()
                .map(|parent| held.ancestry(parent))
                .unwrap_or_default();
            let fields = stored_fields(
                as_obj(row.get("fields")).unwrap_or(&Obj::new()),
                &required_names(row),
                &ancestry,
            );
            let mut stored = Obj::new();
            stored.insert("id".into(), json!(id));
            if let Some(parent) = &parent {
                stored.insert("parent".into(), json!(parent));
            }
            stored.insert("fields".into(), Value::Object(fields.clone()));
            held = held.with(stored);
            declared.push((id.to_string(), parent, fields));
        }
        waiting = later;
    }
    let order = |id: &str| {
        types
            .iter()
            .position(|row| row.get("id").and_then(Value::as_str) == Some(id))
    };
    declared.sort_by_key(|(id, _, _)| order(id));
    declared
        .into_iter()
        .flat_map(|(id, parent, fields)| {
            let ancestry = parent
                .as_deref()
                .map(|parent| held.ancestry(parent))
                .unwrap_or_default();
            let own: Vec<(&str, &Obj)> = fields
                .iter()
                .filter_map(|(name, definition)| Some((name.as_str(), definition.as_object()?)))
                .collect();
            let mut found: Vec<String> = inherited_shape_conflicts(own, &ancestry)
                .into_iter()
                .map(|conflict| {
                    format!(
                        "{}.{} as {}, where {} gives it {}",
                        conflict.field,
                        conflict.attribute,
                        conflict.declared,
                        conflict.owner,
                        conflict.inherited
                    )
                })
                .collect();
            if let Some(row) = held.get(&id) {
                found.extend(word_repeats(&held, row).into_iter().map(|(field, word)| {
                    format!(
                        "the word \"{word}\" of \"{field}\", which a type above it gives already"
                    )
                }));
                let mut thumbnails: Vec<&str> =
                    thumbnails_through(&held, row).into_iter().collect();
                if thumbnails.len() > 1 {
                    thumbnails.sort_unstable();
                    found.push(format!(
                        "more than one thumbnail: {}",
                        thumbnails.join(", ")
                    ));
                }
            }
            found
                .into_iter()
                .map(|text| (id.clone(), text))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Each field as stored, with a required name an ancestor gives restated in the type.
fn stored_fields(fields: &Obj, required_names: &[String], ancestry: &Ancestry) -> Obj {
    let mut normalized = Map::new();
    for (name, definition) in fields {
        let raw = definition
            .as_object()
            .cloned()
            .unwrap_or_else(|| Map::from_iter([("type".to_string(), json!("string"))]));
        normalized.insert(
            name.clone(),
            Value::Object(normalize_field(&raw, Some(required_names.contains(name)))),
        );
    }
    for name in required_names {
        if normalized.contains_key(name) {
            continue;
        }
        if let Some(held) = ancestry.get(name) {
            let mut restated = held.definition.clone();
            restated.insert("required".into(), json!(true));
            if kind(&restated) == Some("status") {
                restated.remove("status_values");
            }
            normalized.insert(name.clone(), Value::Object(restated));
        }
    }
    normalized
}

fn stored_form(
    obj: &Obj,
    fields: Option<&Obj>,
    required_names: &[String],
    ancestry: &Ancestry,
    parent: Option<&str>,
    tables: Obj,
) -> Obj {
    let normalized = stored_fields(fields.unwrap_or(&Obj::new()), required_names, ancestry);
    let mut schema = Map::new();
    schema.insert("id".into(), obj.get("id").cloned().unwrap_or(Value::Null));
    if let Some(label) = obj.get("label").filter(|l| l.is_string()) {
        schema.insert("label".into(), label.clone());
    }
    schema.insert(
        "version".into(),
        obj.get("version")
            .filter(|v| v.is_number())
            .cloned()
            .unwrap_or(json!(0)),
    );
    schema.insert("fields".into(), Value::Object(normalized));
    if !tables.is_empty() {
        schema.insert("tables".into(), Value::Object(tables));
    }
    if let Some(plural) = obj
        .get("plural")
        .filter(|p| p.as_str().is_some_and(|s| !s.is_empty()))
    {
        schema.insert("plural".into(), plural.clone());
    }
    if let Some(description) = obj.get("description").filter(|d| d.is_string()) {
        schema.insert("description".into(), description.clone());
    }
    if let Some(parent) = parent {
        schema.insert("parent".into(), json!(parent));
    }
    if let Some(Value::Array(roles)) = obj
        .get("roles")
        .filter(|r| r.as_array().is_some_and(|a| !a.is_empty()))
    {
        let mut roles: Vec<&str> = roles.iter().filter_map(Value::as_str).collect();
        roles.sort_unstable();
        roles.dedup();
        schema.insert("roles".into(), json!(roles));
    }
    match obj.get("compatible_with") {
        Some(Value::Array(targets)) => {
            schema.insert("compatible_with".into(), Value::Array(targets.clone()));
        }
        Some(Value::String(target)) => {
            schema.insert("compatible_with".into(), json!([target]));
        }
        _ => {}
    }
    if let Some(hints) = as_obj(obj.get("display_hints")) {
        let mut kept = Map::new();
        for (key, wants_flag) in [
            ("title_field", false),
            ("body_field", false),
            ("name_from_body", true),
            ("icon", false),
        ] {
            let value = hints.get(key).filter(|v| {
                if wants_flag {
                    v.is_boolean()
                } else {
                    v.is_string()
                }
            });
            if let Some(value) = value {
                kept.insert(key.into(), value.clone());
            }
        }
        if !kept.is_empty() {
            schema.insert("display_hints".into(), Value::Object(kept));
        }
    }
    if let Some(link) = obj.get("link_field").filter(|l| l.is_string()) {
        schema.insert("link_field".into(), link.clone());
    }
    for key in ["version_policy", "merge_policy", "retention_policy"] {
        if let Some(policy) = as_obj(obj.get(key)) {
            schema.insert(key.into(), Value::Object(policy.clone()));
        }
    }
    schema
}

fn thumbnail_names(fields: Option<&Obj>, ancestry: &Ancestry) -> HashSet<String> {
    let mut found: HashSet<String> = fields
        .into_iter()
        .flatten()
        .filter(|(_, def)| is_thumbnail(Some(def)))
        .map(|(name, _)| name.clone())
        .collect();
    found.extend(
        ancestry
            .iter()
            .filter(|(_, held)| kind(&held.definition) == Some("thumbnail"))
            .map(|(name, _)| name.to_string()),
    );
    found
}

fn validate_roles(obj: &Obj, errors: &mut Vec<Issue>) {
    let Some(roles) = obj.get("roles") else {
        return;
    };
    let Some(roles) = roles.as_array() else {
        errors.push(Issue::new(
            "roles",
            format!("an array of roles ({})", names(&TYPE_ROLES)),
            describe(Some(roles)),
            "Write roles as [\"container\"], or omit it.",
        ));
        return;
    };
    for role in roles {
        if !role.as_str().is_some_and(|r| TYPE_ROLES.contains(&r)) {
            errors.push(Issue::new(
                "roles",
                format!("one of: {}", names(&TYPE_ROLES)),
                describe(Some(role)),
                "Roles are a closed set; an edge constrains on them, so an unrecognized one would never match anything.",
            ));
        }
    }
}

fn validate_display_hints(
    obj: &Obj,
    visible: &HashSet<&str>,
    thumbnails: &HashSet<String>,
    errors: &mut Vec<Issue>,
) {
    let Some(raw) = obj.get("display_hints") else {
        return;
    };
    let Some(hints) = raw.as_object() else {
        errors.push(Issue::new(
            "display_hints",
            "an object, or nothing",
            describe(Some(raw)),
            "Write display_hints as { \"title_field\": \"...\", \"body_field\": \"...\", \"icon\": \"...\" }.",
        ));
        return;
    };
    if hints.contains_key("icon")
        && let Some(refused) = icon_issue(hints.get("icon"), "display_hints.icon")
    {
        errors.push(refused);
    }
    if hints.get("name_from_body").is_some_and(|v| !v.is_boolean()) {
        errors.push(Issue::new(
            "display_hints.name_from_body",
            "true or false",
            describe(hints.get("name_from_body")),
            "Set name_from_body to false where an item's body is not its name, or omit it.",
        ));
    }
    for key in ["title_field", "body_field"] {
        let Some(value) = hints.get(key) else {
            continue;
        };
        let Some(name) = value.as_str() else {
            errors.push(Issue::new(
                format!("display_hints.{key}"),
                "a string naming a field on this type",
                describe(Some(value)),
                format!("Point {key} at one of this type's fields, or omit it."),
            ));
            continue;
        };
        if !visible.contains(name) {
            errors.push(Issue::new(
                format!("display_hints.{key}"),
                "a field this type declares or inherits",
                format!("\"{name}\", which is neither"),
                format!("Declare \"{name}\" in fields, or point {key} at an existing field."),
            ));
        } else if thumbnails.contains(name) {
            errors.push(Issue::new(
                format!("display_hints.{key}"),
                "a field that is not a thumbnail",
                format!("\"{name}\", which is a thumbnail"),
                format!("Point {key} at a text field, or omit it."),
            ));
        }
    }
}

fn visible_definition(
    name: &str,
    fields: Option<&Obj>,
    required_names: &[String],
    ancestry: &Ancestry,
) -> Option<Obj> {
    match fields.and_then(|f| f.get(name)).and_then(Value::as_object) {
        Some(own) => Some(normalize_field(
            own,
            Some(required_names.iter().any(|n| n == name)),
        )),
        None => ancestry.get(name).map(|held| held.definition.clone()),
    }
}

fn validate_link_field(
    obj: &Obj,
    fields: Option<&Obj>,
    required_names: &[String],
    ancestry: &Ancestry,
    errors: &mut Vec<Issue>,
) {
    let Some(value) = obj.get("link_field") else {
        return;
    };
    let Some(name) = value.as_str() else {
        errors.push(Issue::new(
            "link_field",
            "a string naming a string field on this type",
            describe(Some(value)),
            "Point link_field at the field holding the vendor's own id, or omit it.",
        ));
        return;
    };
    if name.contains(['"', '\\']) {
        errors.push(Issue::new(
            "link_field",
            "a field whose name holds no double quote or backslash",
            describe(Some(value)),
            "Rename the field, or point link_field at another string field.",
        ));
        return;
    }
    match visible_definition(name, fields, required_names, ancestry) {
        None => errors.push(Issue::new(
            "link_field",
            "a field this type declares or inherits",
            format!("\"{name}\", which is neither"),
            format!(
                "Declare \"{name}\" in fields as a string, or point link_field at an existing one."
            ),
        )),
        Some(definition) if kind(&definition) != Some("string") => errors.push(Issue::new(
            "link_field",
            "a field of type string",
            format!(
                "\"{name}\", which is of type {}",
                kind(&definition).unwrap_or("nothing")
            ),
            format!("Point link_field at a string field, or declare \"{name}\" as one."),
        )),
        Some(_) => {}
    }
}

fn validate_version_policy(obj: &Obj, errors: &mut Vec<Issue>) {
    let Some(raw) = obj.get("version_policy") else {
        return;
    };
    let Some(policy) = raw.as_object() else {
        errors.push(Issue::new(
            "version_policy",
            "an object, or nothing",
            describe(Some(raw)),
            "version_policy tunes per-item snapshot retention for this type.",
        ));
        return;
    };
    for key in [
        "recent_days",
        "daily_snapshot_days",
        "weekly_snapshot_days",
        "max_versions",
    ] {
        if policy.contains_key(key) && !positive_integer(policy.get(key)) {
            errors.push(Issue::new(
                format!("version_policy.{key}"),
                "a positive integer",
                describe(policy.get(key)),
                format!("Omit {key} to inherit the instance default."),
            ));
        }
    }
    let mut ahead: Option<&str> = None;
    let mut longest = 0.0;
    for key in ["recent_days", "daily_snapshot_days", "weekly_snapshot_days"] {
        if !positive_integer(policy.get(key)) {
            continue;
        }
        let value = number(policy.get(key)).unwrap_or_default();
        if let Some(ahead) = ahead
            && value < longest
        {
            errors.push(Issue::new(
                format!("version_policy.{key}"),
                format!("at least {ahead} ({longest})"),
                describe(policy.get(key)),
                "The windows run recent_days, then daily_snapshot_days, then weekly_snapshot_days, each counted back from now.",
            ));
        }
        if value >= longest {
            longest = value;
            ahead = Some(key);
        }
    }
}

fn validate_merge_policy(obj: &Obj, visible: &HashSet<&str>, errors: &mut Vec<Issue>) {
    let Some(raw) = obj.get("merge_policy") else {
        return;
    };
    let Some(policy) = raw.as_object() else {
        errors.push(Issue::new(
            "merge_policy",
            "an object, or nothing",
            describe(Some(raw)),
            "Write merge_policy as { \"fields\": { \"body\": \"keep_both_copies\" } }.",
        ));
        return;
    };
    let strategies = names(&MERGE_STRATEGIES);
    if let Some(held) = policy.get("fields") {
        match held.as_object() {
            None => errors.push(Issue::new(
                "merge_policy.fields",
                "an object mapping field names to merge strategies",
                describe(Some(held)),
                format!("Strategies are: {strategies}."),
            )),
            Some(held) => {
                for (field, strategy) in held {
                    if !strategy
                        .as_str()
                        .is_some_and(|s| MERGE_STRATEGIES.contains(&s))
                    {
                        errors.push(Issue::new(
                            format!("merge_policy.fields.{field}"),
                            format!("one of: {strategies}"),
                            describe(Some(strategy)),
                            "Pick keep_both_copies for user-authored long text; last_writer_wins otherwise.",
                        ));
                    } else if !visible.contains(field.as_str()) {
                        errors.push(Issue::new(
                            format!("merge_policy.fields.{field}"),
                            "a field this type declares or inherits",
                            format!("\"{field}\", which is neither"),
                            format!("Declare \"{field}\" in fields, or drop the entry."),
                        ));
                    }
                }
            }
        }
    }
    if let Some(default) = policy.get("default")
        && !default
            .as_str()
            .is_some_and(|s| MERGE_STRATEGIES.contains(&s))
    {
        errors.push(Issue::new(
            "merge_policy.default",
            format!("one of: {strategies}"),
            describe(Some(default)),
            "Omit default to fall back to last_writer_wins.",
        ));
    }
}

fn validate_retention_policy(obj: &Obj, errors: &mut Vec<Issue>) {
    let Some(raw) = obj.get("retention_policy") else {
        return;
    };
    let Some(policy) = raw.as_object() else {
        errors.push(Issue::new(
            "retention_policy",
            "an object, or nothing",
            describe(Some(raw)),
            "Write retention_policy as { \"feed_days\": 30 }.",
        ));
        return;
    };
    if text(obj, "id").is_some_and(|id| id.split('.').next() == Some("system")) {
        errors.push(Issue::new(
            "retention_policy",
            "no retention_policy on a system type",
            describe(Some(raw)),
            "System items have no feed tier, so there is nothing to expire. Drop retention_policy.",
        ));
        return;
    }
    let days = policy.get("feed_days");
    if matches!(days, None | Some(Value::Null)) {
        return;
    }
    if !number(days).is_some_and(|n| whole(n) && n >= 1.0 && n <= MAX_FEED_DAYS as f64) {
        errors.push(Issue::new(
            "retention_policy.feed_days",
            format!("a whole number of days from 1 to {MAX_FEED_DAYS}, or null"),
            describe(days),
            "Set null to keep feed items; omit retention_policy to inherit the parent's window.",
        ));
    }
}

fn validate_compatible_with(
    obj: &Obj,
    fields: Option<&Obj>,
    required_names: &[String],
    ancestry: &Ancestry,
    registry: &Registry,
    errors: &mut Vec<Issue>,
) {
    let Some(raw) = obj.get("compatible_with") else {
        return;
    };
    let hint = "Write compatible_with as [\"core.note\"].";
    let targets: Vec<&str> = match raw {
        Value::Array(entries) => {
            if entries.iter().any(|t| !t.is_string()) {
                errors.push(Issue::new(
                    "compatible_with",
                    "every entry to be a type identifier string",
                    describe(Some(raw)),
                    hint,
                ));
                return;
            }
            entries.iter().filter_map(Value::as_str).collect()
        }
        Value::String(target) => vec![target.as_str()],
        other => {
            errors.push(Issue::new(
                "compatible_with",
                "an array of type identifiers, or nothing",
                describe(Some(other)),
                hint,
            ));
            return;
        }
    };
    let mut candidates = Ordered::default();
    for (name, held) in ancestry.iter() {
        let mut definition = held.definition.clone();
        let needed = required(&definition) || required_names.iter().any(|n| n == name);
        definition.insert("required".into(), json!(needed));
        candidates.set(name, definition);
    }
    for (name, raw) in fields.into_iter().flatten() {
        let Some(record) = raw.as_object() else {
            continue;
        };
        let normalized = normalize_field(record, Some(required_names.contains(name)));
        let above = ancestry.get(name).map(|h| &h.definition);
        candidates.set(name, merged(above, &normalized));
    }
    for target in targets {
        if !registry.contains(target) {
            errors.push(
                Issue::new(
                    format!("compatible_with.{target}"),
                    "a registered type identifier",
                    format!("\"{target}\", which is not registered"),
                    "Register the target type first, or drop the claim.",
                )
                .coded("compatible_with_violation"),
            );
            continue;
        }
        for (field, held) in registry.ancestry(target).iter() {
            let wanted = &held.definition;
            let candidate = candidates
                .0
                .iter()
                .find(|(n, _)| n == field)
                .map(|(_, d)| d);
            let coded = |at: String, expected: String, actual: String, hint: String| {
                Issue::new(at, expected, actual, hint).coded("compatible_with_violation")
            };
            if !required(wanted) {
                let Some(candidate) = candidate else { continue };
                if let Some(conflict) = describe_compatibility_conflict(candidate, wanted) {
                    errors.push(coded(
                        format!("compatible_with.{target}.{field}.{}", conflict.attribute),
                        format!("{}, matching \"{target}\"", conflict.expected),
                        conflict.actual,
                        format!("A reader of \"{target}\" reads \"{field}\" whenever it is present and would mis-parse this one. Match its shape, rename this field, or drop the claim."),
                    ));
                }
                continue;
            }
            let Some(candidate) = candidate else {
                errors.push(coded(
                    format!("compatible_with.{target}.{field}"),
                    format!("a \"{field}\" field, required by \"{target}\""),
                    "nothing".into(),
                    format!("Declaring compatibility with \"{target}\" promises every field it requires. Add \"{field}\", or drop the claim."),
                ));
                continue;
            };
            if !required(candidate) {
                errors.push(coded(
                    format!("compatible_with.{target}.{field}.required"),
                    format!("\"{field}\" to be required, matching \"{target}\""),
                    format!("\"{field}\" is optional"),
                    format!("A reader of \"{target}\" expects this field on every item. Mark it required, or drop the claim."),
                ));
            }
            if let Some(conflict) = describe_compatibility_conflict(candidate, wanted) {
                errors.push(coded(
                    format!("compatible_with.{target}.{field}.{}", conflict.attribute),
                    format!("{}, matching \"{target}\"", conflict.expected),
                    conflict.actual,
                    format!("A reader of \"{target}\" would mis-parse this field. Match its shape, or drop the claim."),
                ));
            }
        }
    }
}

/// A field the replaced type declares is always judged below it; an inherited one only where the replacement brings the conflict.
fn validate_descendant_shapes(replaced: &Replaced, descendants: &[&Obj], errors: &mut Vec<Issue>) {
    let (registry, after, stored) = (replaced.before, &replaced.after, &replaced.stored);
    for child in descendants {
        let (Some(parent), Some(declared)) = (text(child, "parent"), as_obj(child.get("fields")))
        else {
            continue;
        };
        let child_id = text(child, "id").unwrap_or_default();
        let own: Vec<(&str, &Obj)> = declared
            .iter()
            .filter_map(|(name, definition)| Some((name.as_str(), definition.as_object()?)))
            .collect();
        let before = inherited_shape_conflicts(own.iter().copied(), &registry.ancestry(parent));
        for conflict in inherited_shape_conflicts(own.iter().copied(), &after.ancestry(parent)) {
            let name = &conflict.field;
            let issue = if stored.contains_key(name) {
                Issue::new(
                    format!("fields.{name}.{}", conflict.attribute),
                    format!("the shape \"{child_id}\" already declares \"{name}\" with"),
                    format!(
                        "{} here, {} in \"{child_id}\"",
                        conflict.inherited, conflict.declared
                    ),
                    format!(
                        "Give \"{name}\" the shape \"{child_id}\" declares, rename it here, or change \"{child_id}\" first."
                    ),
                )
            } else if before.iter().any(|held| {
                (&held.field, held.attribute, &held.inherited, &held.declared)
                    == (
                        &conflict.field,
                        conflict.attribute,
                        &conflict.inherited,
                        &conflict.declared,
                    )
            }) {
                continue;
            } else {
                Issue::new(
                    "parent",
                    format!(
                        "a parent whose chain gives \"{name}\" {}, as \"{child_id}\" declares it",
                        conflict.declared
                    ),
                    format!(
                        "a parent under \"{}\", which gives \"{name}\" {}",
                        conflict.owner, conflict.inherited
                    ),
                    format!("Rename \"{name}\" on \"{child_id}\", or change it there first."),
                )
            };
            errors.push(issue.coded("inheritance_violation"));
        }
    }
}

fn validate_status_fields(
    id: Option<&str>,
    fields: &Obj,
    ancestry: &Ancestry,
    descendants: &[&Obj],
    replaced: Option<&Replaced>,
    errors: &mut Vec<Issue>,
) {
    let own: Vec<(&String, Obj)> = fields
        .iter()
        .filter_map(|(name, def)| {
            let record = def.as_object().filter(|r| kind(r) == Some("status"))?;
            Some((name, normalize_field(record, None)))
        })
        .collect();
    for (extra, _) in own.iter().skip(1) {
        errors.push(Issue::new(
            format!("fields.{extra}.type"),
            "at most one status field in a type",
            format!(
                "status fields {}",
                own.iter()
                    .map(|(n, _)| format!("\"{n}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "Keep one status field and put every word in it.",
        ));
    }
    let mut resolved = Ordered::default();
    for (name, held) in ancestry.iter() {
        resolved.set(name, held.definition.clone());
    }
    let inherited = ancestry
        .iter()
        .find(|(_, held)| kind(&held.definition) == Some("status"));
    for (name, definition) in &own {
        if let Some((inherited_name, held)) = inherited
            && inherited_name != name.as_str()
        {
            errors.push(
                Issue::new(
                    format!("fields.{name}"),
                    format!(
                        "the status field \"{inherited_name}\", inherited from \"{}\"",
                        held.owner
                    ),
                    format!("a second status field \"{name}\""),
                    format!("Add the words to \"{inherited_name}\" instead."),
                )
                .coded("inheritance_violation"),
            );
            continue;
        }
        let above = ancestry.get(name);
        if let Some(above) = above.filter(|a| kind(&a.definition) == Some("status")) {
            let held: HashSet<&str> = words(&above.definition)
                .into_iter()
                .map(|(w, _)| w)
                .collect();
            for (word, _) in words(definition) {
                if held.contains(word) {
                    errors.push(
                        Issue::new(
                            format!("fields.{name}.status_values"),
                            format!("only words \"{}\" and its parents do not declare", above.owner),
                            format!("\"{word}\", which \"{name}\" already takes"),
                            "A subtype adds words to an inherited status field. List only the new ones.",
                        )
                        .coded("inheritance_violation"),
                    );
                }
            }
        }
        let next = merged(above.map(|a| &a.definition), definition);
        resolved.set(name, next);
    }
    let (Some(id), Some(replaced)) = (id, replaced) else {
        return;
    };
    let registry = replaced.before;
    let top = resolved
        .0
        .iter()
        .find(|(_, def)| kind(def) == Some("status"));
    for child in descendants {
        let child_id = text(child, "id").unwrap_or_default();
        let mut below: Vec<&Obj> = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor = Some(*child);
        while let Some(row) = cursor {
            let row_id = text(row, "id").unwrap_or_default();
            if row_id == id || !seen.insert(row_id) {
                break;
            }
            below.insert(0, row);
            cursor = text(row, "parent").and_then(|p| registry.get(p));
        }
        let mut name: Option<&str> = top.map(|(n, _)| n.as_str());
        let mut held_words: HashSet<&str> = top
            .map(|(_, d)| words(d).into_iter().map(|(w, _)| w).collect())
            .unwrap_or_default();
        for row in below {
            let row_id = text(row, "id").unwrap_or_default();
            for (field, def) in as_obj(row.get("fields"))
                .into_iter()
                .flatten()
                .filter_map(|(n, d)| Some((n, d.as_object()?)))
            {
                if kind(def) != Some("status") {
                    continue;
                }
                if let Some(current) = name
                    && field != current
                {
                    if row_id == child_id && top.is_some() {
                        errors.push(
                            Issue::new(
                                format!("fields.{current}"),
                                format!("no status field beside \"{field}\", which \"{child_id}\" declares"),
                                format!("a status field \"{current}\""),
                                format!("Name the status field \"{field}\", or change \"{child_id}\" first."),
                            )
                            .coded("inheritance_violation"),
                        );
                    }
                    continue;
                }
                name = Some(field);
                for (word, _) in words(def) {
                    held_words.insert(word);
                }
            }
        }
        let standing = word_repeats(registry, child);
        for (field, word) in word_repeats(&replaced.after, child) {
            if own.iter().any(|(n, _)| n.as_str() == field) {
                errors.push(
                    Issue::new(
                        format!("fields.{field}.status_values"),
                        format!("no word \"{child_id}\" already declares"),
                        format!("\"{word}\" here and in \"{child_id}\""),
                        format!(
                            "Leave \"{word}\" out here, or remove it from \"{child_id}\" first."
                        ),
                    )
                    .coded("inheritance_violation"),
                );
            } else if !standing.contains(&(field, word)) {
                errors.push(
                    Issue::new(
                        "parent",
                        format!("a parent whose chain does not give \"{field}\" the word \"{word}\", which \"{child_id}\" declares"),
                        format!("a parent whose chain gives \"{field}\" the word \"{word}\""),
                        format!("Remove \"{word}\" from \"{child_id}\" first, or choose another parent."),
                    )
                    .coded("inheritance_violation"),
                );
            }
        }
        if let Some(current) = name
            && held_words.is_empty()
            && as_obj(child.get("fields"))
                .and_then(|f| f.get(current))
                .and_then(Value::as_object)
                .is_some_and(|d| kind(d) == Some("status"))
        {
            errors.push(
                Issue::new(
                    format!("fields.{current}"),
                    format!("a status field with words for \"{child_id}\", which declares \"{current}\" without its own"),
                    format!("no word for \"{current}\" in \"{child_id}\" or above it"),
                    format!("Keep \"{current}\" as a status field with words here, or give \"{child_id}\" its own words first."),
                )
                .coded("inheritance_violation"),
            );
        }
    }
}

/// Each word `child` declares for its status field that a type above it already gives.
fn word_repeats<'a>(registry: &'a Registry, child: &'a Obj) -> Vec<(&'a str, &'a str)> {
    let rows = registry.chain_through(child);
    let mut name: Option<&str> = None;
    let mut held: HashSet<&str> = HashSet::new();
    let mut repeats = Vec::new();
    for (position, row) in rows.iter().enumerate() {
        let last = position + 1 == rows.len();
        for (field, def) in as_obj(row.get("fields"))
            .into_iter()
            .flatten()
            .filter_map(|(n, d)| Some((n.as_str(), d.as_object()?)))
            .filter(|(_, d)| kind(d) == Some("status"))
        {
            if name.is_some_and(|current| current != field) {
                continue;
            }
            name = Some(field);
            for (word, _) in words(def) {
                if !held.insert(word) && last {
                    repeats.push((field, word));
                }
            }
        }
    }
    repeats
}

fn words(definition: &Obj) -> Vec<(&str, &str)> {
    definition
        .get("status_values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|w| Some((w.get("value")?.as_str()?, w.get("group")?.as_str()?)))
        .collect()
}

fn validate_thumbnails(
    fields: &Obj,
    ancestry: &Ancestry,
    descendants: &[&Obj],
    replaced: Option<&Replaced>,
    errors: &mut Vec<Issue>,
) {
    let own: Vec<&String> = fields
        .iter()
        .filter(|(_, d)| is_thumbnail(Some(d)))
        .map(|(n, _)| n)
        .collect();
    for name in &own {
        if SEARCHED_NAMES.contains(&name.as_str()) {
            errors.push(Issue::new(
                format!("fields.{name}"),
                format!("a thumbnail named other than {}", names(&SEARCHED_NAMES)),
                format!("a thumbnail named \"{name}\""),
                format!("Search indexes \"{name}\" whatever its type, which would make the image's base64 searchable. Name it \"thumbnail\"."),
            ));
        }
    }
    let inherited: Vec<String> = ancestry
        .iter()
        .filter(|(name, held)| {
            kind(&held.definition) == Some("thumbnail") && !own.iter().any(|o| o.as_str() == *name)
        })
        .map(|(name, held)| format!("\"{name}\" from \"{}\"", held.owner))
        .collect();
    if let Some(last) = own.last() {
        let all: Vec<String> = own
            .iter()
            .map(|n| format!("\"{n}\""))
            .chain(inherited)
            .collect();
        if all.len() > 1 {
            errors.push(Issue::new(
                format!("fields.{last}"),
                "at most one thumbnail field, counting inherited ones",
                format!("{}: {}", all.len(), all.join(", ")),
                "Keep one thumbnail field.",
            ));
            return;
        }
    }
    let Some(replaced) = replaced else { return };
    let mut crowded: Vec<String> = Vec::new();
    for child in descendants {
        let child_id = text(child, "id").unwrap_or_default();
        let (before, after) = (
            thumbnails_through(replaced.before, child),
            thumbnails_through(&replaced.after, child),
        );
        if after.len() < 2 || (own.is_empty() && after.is_subset(&before)) {
            continue;
        }
        let mut names: Vec<&str> = after.into_iter().collect();
        names.sort_unstable();
        crowded.push(format!(
            "{} in \"{child_id}\"",
            names
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>()
                .join(" and ")
        ));
    }
    if !crowded.is_empty() {
        errors.push(Issue::new(
            own.last()
                .map_or("parent".to_string(), |last| format!("fields.{last}")),
            "at most one thumbnail field in every type that inherits this one",
            format!("a second thumbnail, as {}", crowded.join(", ")),
            "Keep the thumbnail on one level of the hierarchy.",
        ));
    }
}

/// The names of the thumbnail fields a type holds, its own and those it inherits.
fn thumbnails_through<'a>(registry: &'a Registry, child: &'a Obj) -> HashSet<&'a str> {
    let mut names: HashSet<&str> = HashSet::new();
    for row in registry.chain_through(child) {
        for (name, def) in as_obj(row.get("fields")).into_iter().flatten() {
            if as_obj(Some(def)).is_some_and(|d| kind(d) == Some("thumbnail")) {
                names.insert(name);
            }
        }
    }
    names
}

fn validate_descendant_links(
    top: Option<&str>,
    fields: &Obj,
    required_names: &[String],
    ancestry: &Ancestry,
    descendants: &[&Obj],
    registry: &Registry,
    errors: &mut Vec<Issue>,
) {
    let Some(top) = top else { return };
    for child in descendants {
        let Some(name) = text(child, "link_field") else {
            continue;
        };
        if registry.declared_between(child, top, name) {
            continue;
        }
        let definition = visible_definition(name, Some(fields), required_names, ancestry);
        if definition
            .as_ref()
            .is_some_and(|d| kind(d) == Some("string"))
        {
            continue;
        }
        let child_id = text(child, "id").unwrap_or_default();
        errors.push(Issue::new(
            format!("fields.{name}"),
            format!("a string field \"{name}\", which \"{child_id}\" names as its link_field"),
            match &definition {
                Some(d) => format!("\"{name}\" of type {}", kind(d).unwrap_or("nothing")),
                None => format!("no field \"{name}\""),
            },
            format!("Keep \"{name}\" a string field, or point the link_field of \"{child_id}\" elsewhere first."),
        ));
    }
}

fn validate_descendant_members(
    top: Option<&str>,
    visible: &HashSet<&str>,
    descendants: &[&Obj],
    registry: &Registry,
    errors: &mut Vec<Issue>,
) {
    let Some(top) = top else { return };
    for child in descendants {
        let child_id = text(child, "id").unwrap_or_default();
        let mut named: Vec<(String, String)> = Vec::new();
        for key in ["title_field", "body_field"] {
            if let Some(value) = as_obj(child.get("display_hints")).and_then(|h| text(h, key)) {
                named.push((value.to_string(), format!("display_hints.{key}")));
            }
        }
        for field in as_obj(child.get("merge_policy"))
            .and_then(|m| as_obj(m.get("fields")))
            .into_iter()
            .flat_map(Map::keys)
        {
            named.push((field.clone(), "merge_policy.fields".into()));
        }
        for (name, member) in named {
            if visible.contains(name.as_str()) || registry.declared_between(child, top, &name) {
                continue;
            }
            errors.push(Issue::new(
                format!("fields.{name}"),
                format!("a field \"{name}\", which \"{child_id}\" names in its {member}"),
                format!("no field \"{name}\""),
                format!("Keep \"{name}\", or change the {member} of \"{child_id}\" first."),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        Registry::new([json!({"id": "user.base", "version": 0, "fields": {
            "title": {"type": "string", "required": true},
            "stage": {"type": "status", "status_values": [{"value": "open", "group": "not_started"}]}
        }})
        .as_object()
        .cloned()
        .unwrap_or_default()])
    }

    fn refused(input: Value) -> Vec<(String, Option<&'static str>)> {
        validate_type(&input, &registry())
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|i| (i.field, i.code))
            .collect()
    }

    #[test]
    fn a_child_may_not_change_an_inherited_shape_or_loosen_it() {
        let found = refused(
            json!({"id": "user.child", "parent": "user.base", "fields": {
                "title": {"type": "number"}
            }}),
        );
        assert!(found.contains(&("fields.title.type".into(), Some("inheritance_violation"))));
        let loose = refused(
            json!({"id": "user.child", "parent": "user.base", "fields": {
                "title": {"type": "string", "required": false}
            }}),
        );
        assert_eq!(
            loose,
            vec![(
                "fields.title.required".to_string(),
                Some("inheritance_violation")
            )]
        );
        let kept = refused(
            json!({"id": "user.child", "parent": "user.base", "fields": {
                "title": {"type": "string", "required": true}
            }}),
        );
        assert!(kept.is_empty(), "{kept:?}");
    }

    #[test]
    fn a_type_may_not_take_a_parent_above_which_a_subtype_declares_an_inherited_field_otherwise() {
        let held = Registry::new(
            [
                json!({"id": "user.top", "version": 0, "fields": {
                    "count": {"type": "integer"},
                    "kind": {"type": "string", "required": true}}}),
                json!({"id": "user.middle", "version": 0, "fields": {"title": {"type": "string"}}}),
                json!({"id": "user.middle.leaf", "parent": "user.middle", "version": 0,
                       "fields": {"count": {"type": "string"}, "kind": {"type": "string"}}}),
            ]
            .map(|row| row.as_object().cloned().unwrap_or_default()),
        );
        let attached = json!({"id": "user.middle", "parent": "user.top", "fields": {
            "title": {"type": "string"}}});
        let found: Vec<_> = validate_type(&attached, &held)
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|issue| (issue.field, issue.code))
            .collect();
        assert_eq!(
            found,
            vec![
                ("parent".to_string(), Some("inheritance_violation")),
                ("parent".to_string(), Some("inheritance_violation")),
            ]
        );
        let detached = json!({"id": "user.middle", "fields": {"title": {"type": "string"}}});
        assert!(validate_type(&detached, &held).is_ok());
    }

    #[test]
    fn a_replacement_is_not_refused_for_a_conflict_below_it_that_it_does_not_bring() {
        let row = |value: Value| value.as_object().cloned().unwrap_or_default();
        let held = Registry::new([
            row(json!({"id": "user.top", "version": 0, "fields": {"count": {"type": "integer"}}})),
            row(json!({"id": "user.top.middle", "parent": "user.top", "version": 0, "fields": {}})),
            row(
                json!({"id": "user.top.middle.leaf", "parent": "user.top.middle", "version": 0,
                       "fields": {"count": {"type": "string"}}}),
            ),
        ]);
        let relabelled = json!({"id": "user.top.middle", "parent": "user.top", "label": "Middle",
                                "fields": {}});
        let kept = validate_type(&relabelled, &held);
        assert!(kept.is_ok(), "{:?}", kept.err());
        let declared = json!({"id": "user.top.middle", "parent": "user.top",
                              "fields": {"count": {"type": "integer"}}});
        let found: Vec<_> = validate_type(&declared, &held)
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|issue| issue.field)
            .collect();
        assert_eq!(found, ["fields.count.type"]);
    }

    fn rows(values: Vec<Value>) -> Registry {
        Registry::new(
            values
                .into_iter()
                .map(|row| row.as_object().cloned().unwrap_or_default()),
        )
    }

    fn found(input: &Value, held: &Registry) -> Vec<(String, Option<&'static str>)> {
        validate_type(input, held)
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|issue| (issue.field, issue.code))
            .collect()
    }

    #[test]
    fn a_type_may_not_take_a_parent_whose_status_word_a_subtype_declares() {
        let words = |word: &str, group: &str| json!({"type": "status", "status_values": [{"value": word, "group": group}]});
        let held = rows(vec![
            json!({"id": "user.top", "version": 0, "fields": {"stage": words("open", "not_started")}}),
            json!({"id": "user.middle", "version": 0, "fields": {"title": {"type": "string"}}}),
            json!({"id": "user.middle.leaf", "parent": "user.middle", "version": 0,
                   "fields": {"stage": words("open", "completed")}}),
        ]);
        let attached = json!({"id": "user.middle", "parent": "user.top",
                              "fields": {"title": {"type": "string"}}});
        assert_eq!(
            found(&attached, &held),
            [("parent".to_string(), Some("inheritance_violation"))]
        );
        let detached = json!({"id": "user.middle", "fields": {"title": {"type": "string"}}});
        assert!(validate_type(&detached, &held).is_ok());
    }

    #[test]
    fn a_replacement_is_not_refused_for_a_status_word_repeated_below_it_that_it_does_not_bring() {
        let words = |word: &str| json!({"type": "status", "status_values": [{"value": word, "group": "completed"}]});
        let held = rows(vec![
            json!({"id": "user.top", "version": 0, "fields": {"stage": words("open")}}),
            json!({"id": "user.top.middle", "parent": "user.top", "version": 0, "fields": {}}),
            json!({"id": "user.top.middle.leaf", "parent": "user.top.middle", "version": 0,
                   "fields": {"stage": words("open")}}),
        ]);
        let relabelled = json!({"id": "user.top.middle", "parent": "user.top",
                                "label": "Middle", "fields": {}});
        assert!(validate_type(&relabelled, &held).is_ok());
        let declared = json!({"id": "user.top.middle", "parent": "user.top",
                              "fields": {"stage": words("other")}});
        assert_eq!(
            found(&declared, &held),
            [(
                "fields.stage.status_values".to_string(),
                Some("inheritance_violation")
            )]
        );
    }

    #[test]
    fn a_type_may_not_take_a_parent_whose_thumbnail_a_subtype_declares_another_of() {
        let held = rows(vec![
            json!({"id": "user.top", "version": 0, "fields": {"picture": {"type": "thumbnail"}}}),
            json!({"id": "user.middle", "version": 0, "fields": {"title": {"type": "string"}}}),
            json!({"id": "user.middle.leaf", "parent": "user.middle", "version": 0,
                   "fields": {"preview": {"type": "thumbnail"}}}),
        ]);
        let attached = json!({"id": "user.middle", "parent": "user.top",
                              "fields": {"title": {"type": "string"}}});
        assert_eq!(found(&attached, &held), [("parent".to_string(), None)]);
        let detached = json!({"id": "user.middle", "fields": {"title": {"type": "string"}}});
        assert!(validate_type(&detached, &held).is_ok());
        let same = rows(vec![
            json!({"id": "user.top", "version": 0, "fields": {"picture": {"type": "thumbnail"}}}),
            json!({"id": "user.middle", "version": 0, "fields": {"title": {"type": "string"}}}),
            json!({"id": "user.middle.leaf", "parent": "user.middle", "version": 0,
                   "fields": {"picture": {"type": "thumbnail"}}}),
        ]);
        assert!(validate_type(&attached, &same).is_ok());
    }

    #[test]
    fn a_replacement_is_not_refused_for_a_thumbnail_below_it_that_it_does_not_bring() {
        let held = rows(vec![
            json!({"id": "user.top", "version": 0, "fields": {"picture": {"type": "thumbnail"}}}),
            json!({"id": "user.top.middle", "parent": "user.top", "version": 0, "fields": {}}),
            json!({"id": "user.top.middle.leaf", "parent": "user.top.middle", "version": 0,
                   "fields": {"preview": {"type": "thumbnail"}}}),
        ]);
        let relabelled = json!({"id": "user.top.middle", "parent": "user.top",
                                "label": "Middle", "fields": {}});
        assert!(validate_type(&relabelled, &held).is_ok());
    }

    #[test]
    fn a_move_between_parents_that_give_a_field_alike_keeps_the_conflict_below_it() {
        let held = rows(vec![
            json!({"id": "user.first", "version": 0, "fields": {"count": {"type": "integer"}}}),
            json!({"id": "user.second", "version": 0, "fields": {"count": {"type": "integer"}}}),
            json!({"id": "user.first.middle", "parent": "user.first", "version": 0, "fields": {}}),
            json!({"id": "user.first.middle.leaf", "parent": "user.first.middle", "version": 0,
                   "fields": {"count": {"type": "string"}}}),
        ]);
        let moved = json!({"id": "user.first.middle", "parent": "user.second", "fields": {}});
        let kept = validate_type(&moved, &held);
        assert!(kept.is_ok(), "{:?}", kept.err());
        let other = rows(vec![
            json!({"id": "user.first", "version": 0, "fields": {"count": {"type": "integer"}}}),
            json!({"id": "user.second", "version": 0, "fields": {"count": {"type": "number"}}}),
            json!({"id": "user.first.middle", "parent": "user.first", "version": 0, "fields": {}}),
            json!({"id": "user.first.middle.leaf", "parent": "user.first.middle", "version": 0,
                   "fields": {"count": {"type": "string"}}}),
        ]);
        assert_eq!(
            found(&moved, &other),
            [("parent".to_string(), Some("inheritance_violation"))]
        );
    }

    #[test]
    fn a_declared_set_is_judged_down_every_chain_in_any_order() {
        let found = |set: Vec<Value>| -> Vec<(String, String)> {
            declared_conflicts(&set)
                .into_iter()
                .map(|(id, text)| {
                    (
                        id,
                        text.split(" as ").next().unwrap_or_default().to_string(),
                    )
                })
                .collect()
        };
        let top = json!({"id": "app.t.top", "fields": {"n": {"type": "integer"}}});
        let middle = json!({"id": "app.t.middle", "parent": "app.t.top", "required": ["n"],
                            "fields": {}});
        let leaf = |field: Value| {
            json!({"id": "app.t.leaf", "parent": "app.t.middle",
                                         "fields": {"n": field}})
        };
        let loose = found(vec![
            leaf(json!({"type": "integer"})),
            middle.clone(),
            top.clone(),
        ]);
        assert_eq!(
            loose,
            [("app.t.leaf".to_string(), "n.required".to_string())]
        );
        let kept = found(vec![
            leaf(json!({"type": "integer", "required": true})),
            middle,
            top,
        ]);
        assert!(kept.is_empty(), "{kept:?}");
        let around = found(vec![
            json!({"id": "app.t.a", "parent": "app.t.b", "fields": {"n": {"type": "string"}}}),
            json!({"id": "app.t.b", "parent": "app.t.a", "fields": {"n": {"type": "integer"}}}),
        ]);
        assert!(!around.is_empty());
    }

    #[test]
    fn a_field_may_not_take_an_item_s_own_name_and_a_second_status_is_refused() {
        let found = refused(
            json!({"id": "user.other", "parent": "user.base", "fields": {
                "state": {"type": "string"},
                "phase": {"type": "status", "status_values": [{"value": "a", "group": "completed"}]}
            }}),
        );
        assert!(found.contains(&("fields.state".into(), Some("property_shadows_field"))));
        assert!(found.contains(&("fields.phase".into(), Some("inheritance_violation"))));
    }

    #[test]
    fn what_is_stored_drops_the_defaults_and_folds_the_format() {
        let stored = validate_type(
            &json!({"id": "user.leaf", "roles": ["container", "container"], "fields": {
                "link": {"type": "string", "format": "url", "searchable": true, "required": false}
            }, "compatible_with": "user.base", "required": ["link"]}),
            &registry(),
        );
        let Err(errors) = stored else {
            panic!("user.base requires a title")
        };
        assert!(
            errors
                .iter()
                .all(|i| i.code == Some("compatible_with_violation"))
        );
        let stored = validate_type(
            &json!({"id": "user.leaf", "roles": ["container", "container"], "fields": {
                "link": {"type": "string", "format": "url", "searchable": true, "required": false}
            }}),
            &registry(),
        )
        .unwrap_or_default();
        assert_eq!(stored["roles"], json!(["container"]));
        assert_eq!(stored["fields"]["link"], json!({"type": "url"}));
    }
}
