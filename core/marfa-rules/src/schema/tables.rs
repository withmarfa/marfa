//! The tables a type declares and their columns, judged by one column validator.

use serde_json::{Map, Value, json};

use super::field::{label_issue, normalize_field, validate_member, vocabulary};
use super::resolve::label_member;
use super::unread::unread_column_keys;
use super::{Issue, Obj, Registry, as_obj, describe, kind, names, text};
use crate::catalog::api_name;
use crate::grammar;

pub const MAX_TABLES_PER_TYPE: usize = 32;
pub const MAX_COLUMNS_PER_TABLE: usize = 64;
/// The kind of a column that holds an item's id.
pub const ITEM_KIND: &str = "item";
/// How a column's values total: `count` is the rows that hold a value.
pub const ADDS_UP: [&str; 5] = ["sum", "average", "min", "max", "count"];

const TEXT_KINDS: [&str; 3] = ["string", "email", "url"];
const ITEM_COLUMN_REFUSES: [&str; 5] = ["enum_values", "format", "maxLength", "minimum", "maximum"];
const NAME_RULE: &str =
    "a lowercase letter, then up to 63 lowercase letters, digits and underscores";

fn column_kinds() -> Vec<String> {
    let mut kinds = vocabulary().member_types.clone();
    kinds.push(ITEM_KIND.to_string());
    kinds
}

fn ways_to_add_up(kind: &str) -> &'static [&'static str] {
    match kind {
        "number" | "integer" => &ADDS_UP,
        "date" | "datetime" => &["min", "max", "count"],
        _ => &["count"],
    }
}

fn name_issue(path: &str, name: &str, what: &str) -> Option<Issue> {
    (!api_name(name)).then(|| {
        Issue::new(
            path,
            format!("{what} named by {NAME_RULE}"),
            describe(Some(&Value::String(name.to_string()))),
            format!("Rename the {what}: it appears in addresses and commands."),
        )
    })
}

/// Judges the columns of one table at `path`; `type_known` says which types an item column may name.
pub fn validate_columns(
    columns: Option<&Value>,
    path: &str,
    type_known: &dyn Fn(&str) -> bool,
    errors: &mut Vec<Issue>,
) {
    let Some(columns) = columns.and_then(Value::as_object).filter(|c| !c.is_empty()) else {
        errors.push(Issue::new(
            path,
            "an object naming at least one column",
            describe(columns),
            "Name each column, e.g. { \"amount\": { \"type\": \"number\" } }.",
        ));
        return;
    };
    if columns.len() > MAX_COLUMNS_PER_TABLE {
        errors.push(Issue::new(
            path,
            format!("at most {MAX_COLUMNS_PER_TABLE} columns"),
            format!("{} columns", columns.len()),
            "A table is narrow. Split it, or move what does not vary by row into a field.",
        ));
    }
    for (name, definition) in columns {
        let column = format!("{path}.{name}");
        errors.extend(name_issue(&column, name, "column"));
        validate_column(&column, definition, type_known, errors);
    }
}

fn validate_column(
    path: &str,
    definition: &Value,
    type_known: &dyn Fn(&str) -> bool,
    errors: &mut Vec<Issue>,
) {
    let Some(column) = definition.as_object() else {
        errors.push(Issue::new(
            path,
            "an object describing the column",
            describe(Some(definition)),
            format!("Write {path} as {{ \"type\": \"string\" }}."),
        ));
        return;
    };
    errors.extend(unread_column_keys(column, path));
    let kinds = column_kinds();
    let Some(declared) = text(column, "type").filter(|k| kinds.iter().any(|held| held == k)) else {
        errors.push(Issue::new(
            format!("{path}.type"),
            format!("one of: {}", kinds.join(", ")),
            describe(column.get("type")),
            "A column holds one plain value, or the id of an item. A list, an object, a status or a thumbnail would need nesting a column does not have.",
        ));
        return;
    };
    let issue = |suffix: &str, expected: String, actual: String, hint: String| {
        Issue::new(format!("{path}.{suffix}"), expected, actual, hint)
    };
    if declared == ITEM_KIND {
        label_issue(
            &format!("{path}.label"),
            column.get("label"),
            errors,
            "A label is the name an app shows for it. Omit it to make one from the name.",
        );
        for key in ITEM_COLUMN_REFUSES {
            if column.contains_key(key) {
                errors.push(issue(
                    key,
                    format!("no {key} on an item column"),
                    describe(column.get(key)),
                    "An item column holds an id. Name the types it may point at in type_constraints.".into(),
                ));
            }
        }
    } else {
        validate_member(path, definition, errors);
        if column.contains_key("type_constraints") {
            errors.push(issue(
                "type_constraints",
                "type_constraints on an item column".into(),
                format!("type_constraints on a {declared} column"),
                "Set the type to \"item\", or drop type_constraints.".into(),
            ));
        }
    }
    if column.get("description").is_some_and(|d| !d.is_string()) {
        errors.push(issue(
            "description",
            "a string, or nothing".into(),
            describe(column.get("description")),
            "A description says what the column holds.".into(),
        ));
    }
    if column.get("required").is_some_and(|r| !r.is_boolean()) {
        errors.push(issue(
            "required",
            "true or false".into(),
            describe(column.get("required")),
            "Set required: true to make every row hold a value, or omit it.".into(),
        ));
    }
    let held_kind = kind(&normalize_field(column, None))
        .unwrap_or(declared)
        .to_string();
    match column.get("searchable") {
        None | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) if TEXT_KINDS.contains(&held_kind.as_str()) => {}
        Some(Value::Bool(true)) => errors.push(issue(
            "searchable",
            format!("searchable only on a {} column", names(&TEXT_KINDS)),
            format!("searchable on a {held_kind} column"),
            "Search indexes text. Drop searchable from this column.".into(),
        )),
        Some(other) if declared == ITEM_KIND => errors.push(issue(
            "searchable",
            "a boolean".into(),
            describe(Some(other)),
            "Set searchable: true to feed search from a text column; omit it to keep the column out.".into(),
        )),
        Some(_) => {}
    }
    if let Some(way) = column.get("adds_up") {
        let ways = ways_to_add_up(&held_kind);
        if !way.as_str().is_some_and(|w| ways.contains(&w)) {
            errors.push(issue(
                "adds_up",
                format!("one of: {}", names(ways)),
                match way.as_str() {
                    Some(word) => format!("\"{word}\" on a {held_kind} column"),
                    None => describe(Some(way)),
                },
                "adds_up says how a column totals. Omit it for a column that has no total.".into(),
            ));
        }
    }
    if let Some(constraints) = column
        .get("type_constraints")
        .filter(|_| declared == ITEM_KIND)
    {
        validate_constraints(
            &format!("{path}.type_constraints"),
            constraints,
            type_known,
            errors,
        );
    }
}

fn validate_constraints(
    path: &str,
    constraints: &Value,
    type_known: &dyn Fn(&str) -> bool,
    errors: &mut Vec<Issue>,
) {
    let Some(entries) = constraints.as_array().filter(|e| !e.is_empty()) else {
        errors.push(Issue::new(
            path,
            "a non-empty array of type identifiers",
            describe(Some(constraints)),
            "List the types the item may be, or omit type_constraints to accept any.",
        ));
        return;
    };
    for entry in entries {
        match entry.as_str() {
            Some(id) if grammar::type_id(id).unwrap_or(false) && type_known(id) => {}
            Some(id) if grammar::type_id(id).unwrap_or(false) => errors.push(Issue::new(
                path,
                "a registered type identifier",
                format!("\"{id}\", which is not registered"),
                "Register the type first, or drop it from type_constraints.",
            )),
            _ => errors.push(Issue::new(
                path,
                "every entry to be a type identifier",
                describe(Some(entry)),
                "Write each type as a string such as \"core.note\".",
            )),
        }
    }
}

/// Judges a type's own `tables` against its ancestors' and its descendants'.
pub(super) fn validate_tables(
    raw: Option<&Value>,
    inherited: &[(String, String, Obj)],
    descendants: &[&Obj],
    type_known: &dyn Fn(&str) -> bool,
    errors: &mut Vec<Issue>,
) {
    descendants_hold_inherited_tables(inherited, descendants, errors);
    let Some(raw) = raw else { return };
    let Some(tables) = raw.as_object() else {
        errors.push(Issue::new(
            "tables",
            "an object mapping table names to definitions, or nothing",
            describe(Some(raw)),
            "Write tables as { \"entries\": { \"columns\": { ... } } }.",
        ));
        return;
    };
    if tables.len() > MAX_TABLES_PER_TYPE {
        errors.push(Issue::new(
            "tables",
            format!("at most {MAX_TABLES_PER_TYPE} tables"),
            format!("{} tables", tables.len()),
            "A table is what an item holds many of. Keep a type to a few.",
        ));
    }
    for (name, definition) in tables {
        let path = format!("tables.{name}");
        errors.extend(name_issue(&path, name, "table"));
        let Some(table) = definition.as_object() else {
            errors.push(Issue::new(
                path.clone(),
                "an object describing the table",
                describe(Some(definition)),
                format!("Write {path} as {{ \"columns\": {{ ... }} }}."),
            ));
            continue;
        };
        label_issue(
            &format!("{path}.label"),
            table.get("label"),
            errors,
            "A label is the name an app shows for it. Omit it to make one from the name.",
        );
        if table.get("description").is_some_and(|d| !d.is_string()) {
            errors.push(Issue::new(
                format!("{path}.description"),
                "a string, or nothing",
                describe(table.get("description")),
                "A description says what the table holds.",
            ));
        }
        validate_columns(
            table.get("columns"),
            &format!("{path}.columns"),
            type_known,
            errors,
        );
        if let Some((_, owner, held)) = inherited.iter().find(|(held, _, _)| held == name)
            && !restates(name, table, held)
        {
            errors.push(
                Issue::new(
                    path.clone(),
                    format!("the table \"{name}\" as \"{owner}\" declares it, or no declaration"),
                    "a table of that name with another definition".to_string(),
                    format!("A table is declared once down a chain. Change it on \"{owner}\", or give this one another name."),
                )
                .coded("inheritance_violation"),
            );
        }
        for child in descendants {
            let declares_otherwise = as_obj(child.get("tables"))
                .and_then(|held| as_obj(held.get(name)))
                .is_some_and(|held| !restates(name, held, &normalize_table(table)));
            if declares_otherwise {
                let child_id = text(child, "id").unwrap_or_default();
                errors.push(
                    Issue::new(
                        path.clone(),
                        format!("no table \"{name}\", which \"{child_id}\" declares"),
                        format!("a table \"{name}\""),
                        format!(
                            "Give the table another name, or remove it from \"{child_id}\" first."
                        ),
                    )
                    .coded("inheritance_violation"),
                );
            }
        }
    }
}

fn descendants_hold_inherited_tables(
    inherited: &[(String, String, Obj)],
    descendants: &[&Obj],
    errors: &mut Vec<Issue>,
) {
    for child in descendants {
        let child_id = text(child, "id").unwrap_or_default();
        for (name, table) in as_obj(child.get("tables")).into_iter().flatten() {
            let Some((_, owner, held)) = inherited.iter().find(|(held, _, _)| held == name) else {
                continue;
            };
            if as_obj(Some(table)).is_some_and(|table| restates(name, table, held)) {
                continue;
            }
            errors.push(
                Issue::new(
                    "parent",
                    format!("a parent whose chain does not declare the table \"{name}\" otherwise than \"{child_id}\" does"),
                    format!("a parent under \"{owner}\", which declares \"{name}\" otherwise"),
                    format!("Rename the table on \"{child_id}\", or change it there first."),
                )
                .coded("inheritance_violation"),
            );
        }
    }
}

/// Table faults by declaring type, including conflicts within the declared set.
pub fn declared_tables_issues(
    types: &[Value],
    type_known: &dyn Fn(&str) -> bool,
) -> Vec<(String, Issue)> {
    let registry = Registry::new(types.iter().filter_map(|row| row.as_object().cloned()));
    let mut found = Vec::new();
    for definition in types.iter().filter_map(Value::as_object) {
        let Some(id) = text(definition, "id") else {
            continue;
        };
        let parent = text(definition, "parent").filter(|parent| *parent != id);
        let inherited = parent
            .map(|p| registry.inherited_tables(p))
            .unwrap_or_default();
        let mut issues = Vec::new();
        validate_tables(
            definition.get("tables"),
            &inherited,
            &registry.descendants(id),
            type_known,
            &mut issues,
        );
        found.extend(issues.into_iter().map(|issue| (id.to_string(), issue)));
    }
    found
}

fn restates(name: &str, table: &Obj, held: &Obj) -> bool {
    labelled_table(name, &normalize_table(table)) == labelled_table(name, held)
}

fn normalize_column(raw: &Obj) -> Obj {
    let mut out = normalize_field(raw, None);
    out.remove("searchable");
    if raw.get("searchable") == Some(&Value::Bool(true)) {
        out.insert("searchable".into(), json!(true));
    }
    for key in ["adds_up", "type_constraints"] {
        if let Some(value) = raw.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    out
}

/// What a table is stored as: only what differs from the defaults.
pub fn normalize_table(raw: &Obj) -> Obj {
    let mut out = Map::new();
    for key in ["label", "description"] {
        if let Some(value) = raw
            .get(key)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            out.insert(key.into(), value.clone());
        }
    }
    let columns = as_obj(raw.get("columns")).into_iter().flatten();
    let columns = columns.filter_map(|(name, column)| {
        Some((
            name.clone(),
            Value::Object(normalize_column(column.as_object()?)),
        ))
    });
    out.insert("columns".into(), Value::Object(columns.collect()));
    out
}

/// A type's own tables, without any it restates exactly as an ancestor declares it.
pub(super) fn stored_tables(raw: Option<&Value>, inherited: &[(String, String, Obj)]) -> Obj {
    as_obj(raw)
        .into_iter()
        .flatten()
        .filter_map(|(name, table)| Some((name, table.as_object()?)))
        .filter(|(name, table)| {
            !inherited
                .iter()
                .any(|(held, _, definition)| held == *name && restates(name, table, definition))
        })
        .map(|(name, table)| (name.clone(), Value::Object(normalize_table(table))))
        .collect()
}

fn labelled_table(name: &str, table: &Obj) -> Obj {
    let mut table = table.clone();
    label_member(&mut table, name);
    if let Some(Value::Object(columns)) = table.get_mut("columns") {
        for (column, definition) in columns.iter_mut() {
            if let Value::Object(definition) = definition {
                label_member(definition, column);
            }
        }
    }
    table
}

/// Each table and column without a label reads by its name, `due_at` as `Due At`.
pub fn with_table_labels(tables: &Obj) -> Obj {
    tables
        .iter()
        .map(|(name, table)| {
            let table = as_obj(Some(table))
                .map_or_else(|| table.clone(), |t| Value::Object(labelled_table(name, t)));
            (name.clone(), table)
        })
        .collect()
}

/// Defaults a table leaves out are written down, so two equal definitions compare equal.
pub(super) fn with_column_defaults(tables: &mut Obj) {
    for table in tables.values_mut() {
        let Some(Value::Object(columns)) = table.get_mut("columns") else {
            continue;
        };
        for column in columns.values_mut() {
            if let Value::Object(definition) = column {
                definition.entry("required").or_insert(Value::Bool(false));
                definition.entry("searchable").or_insert(Value::Bool(false));
            }
        }
    }
}

/// Drops a label the stored table does not set and the submission gives as read.
pub(super) fn without_read_labels(submitted: &mut Obj, stored: Option<&Obj>, read: Option<&Obj>) {
    for (name, table) in submitted.iter_mut() {
        let Value::Object(table) = table else {
            continue;
        };
        let own = stored.and_then(|s| as_obj(s.get(name)));
        let seen = read.and_then(|r| as_obj(r.get(name)));
        let (Some(own), Some(seen)) = (own, seen) else {
            continue;
        };
        if !own.contains_key("label") && table.get("label") == seen.get("label") {
            table.remove("label");
        }
        let own_columns = as_obj(own.get("columns"));
        let seen_columns = as_obj(seen.get("columns"));
        if let Some(Value::Object(columns)) = table.get_mut("columns") {
            for (column, definition) in columns.iter_mut() {
                let (Value::Object(definition), Some(seen)) =
                    (definition, seen_columns.and_then(|c| as_obj(c.get(column))))
                else {
                    continue;
                };
                let own = own_columns.and_then(|c| as_obj(c.get(column)));
                if own.is_none_or(|own| !own.contains_key("label"))
                    && definition.get("label") == seen.get("label")
                {
                    definition.remove("label");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::{Issue, Registry, evolution_of, resolve, validate_type};

    fn registry() -> Registry {
        Registry::new(
            [
                json!({"id": "user.base", "version": 0, "fields": {"title": {"type": "string"}},
                       "tables": {"entries": {"label": "Entries", "columns": {
                           "note": {"type": "string"}}}}}),
                json!({"id": "user.file", "version": 0, "fields": {"title": {"type": "string"}}}),
            ]
            .into_iter()
            .filter_map(|row| row.as_object().cloned()),
        )
    }

    fn judged(input: Value) -> Result<serde_json::Map<String, Value>, Vec<Issue>> {
        validate_type(&input, &registry())
    }

    fn fields_of(input: Value) -> Vec<String> {
        judged(input)
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|issue| issue.field)
            .collect()
    }

    fn with_columns(columns: Value) -> Value {
        json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
               "tables": {"lines": {"columns": columns}}})
    }

    #[test]
    fn a_type_declares_tables_and_keeps_only_what_differs_from_the_defaults() {
        let stored = judged(json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "tables": {"lines": {"label": "Lines", "description": "What was spent.", "columns": {
                "amount": {"type": "number", "adds_up": "sum", "required": false, "searchable": false},
                "memo": {"type": "string", "searchable": true},
                "picture": {"type": "item", "type_constraints": ["user.file"]},
                "kind": {"type": "enum", "enum_values": ["a", "b"]},
                "seen": {"type": "string", "format": "date"}
            }}}}))
        .unwrap_or_default();
        assert_eq!(
            stored["tables"]["lines"],
            json!({"label": "Lines", "description": "What was spent.", "columns": {
                "amount": {"type": "number", "adds_up": "sum"},
                "memo": {"type": "string", "searchable": true},
                "picture": {"type": "item", "type_constraints": ["user.file"]},
                "kind": {"type": "enum", "enum_values": ["a", "b"]},
                "seen": {"type": "date"}
            }})
        );
    }

    #[test]
    fn a_type_without_tables_stores_none() {
        let stored = judged(json!({"id": "user.plain", "fields": {"title": {"type": "string"}}}))
            .unwrap_or_default();
        assert!(!stored.contains_key("tables"));
    }

    #[test]
    fn an_unread_key_is_refused_with_the_key_meant_at_every_level() {
        let found = judged(
            json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "Tables": {},
            "tables": {"lines": {"Label": "Lines", "columns": {
                "amount": {"type": "number", "addsUp": "sum"}}}}}),
        )
        .err()
        .unwrap_or_default();
        let hint_for = |field: &str| {
            found
                .iter()
                .find(|issue| issue.field == field)
                .map(|issue| issue.hint.clone())
        };
        assert!(
            hint_for("Tables")
                .unwrap_or_default()
                .contains("\"tables\"")
        );
        assert!(
            hint_for("tables.lines.Label")
                .unwrap_or_default()
                .contains("\"label\"")
        );
        assert!(
            hint_for("tables.lines.columns.amount.addsUp")
                .unwrap_or_default()
                .contains("\"adds_up\"")
        );
    }

    #[test]
    fn a_column_kind_that_does_not_exist_is_refused_and_a_nested_kind_is_not_a_column_kind() {
        let found = fields_of(with_columns(json!({
            "a": {"type": "decimal"},
            "b": {"type": "array", "items_type": "string"},
            "c": {"type": "status", "status_values": [{"value": "x", "group": "completed"}]},
            "d": {},
            "e": {"type": "string", "format": "thumbnail"}
        })));
        for column in ["a", "b", "c", "d", "e"] {
            assert!(
                found.contains(&format!("tables.lines.columns.{column}.type")),
                "{column}: {found:?}"
            );
        }
    }

    #[test]
    fn a_table_and_a_column_are_named_as_an_api_name() {
        let found = fields_of(
            json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "tables": {"Lines": {"columns": {"x": {"type": "string"}}},
                       "ok": {"columns": {"Bad Name": {"type": "string"}}}}}),
        );
        assert!(found.contains(&"tables.Lines".to_string()), "{found:?}");
        assert!(
            found.contains(&"tables.ok.columns.Bad Name".to_string()),
            "{found:?}"
        );
    }

    #[test]
    fn a_table_needs_columns() {
        for bad in [json!({}), json!([]), json!("x"), Value::Null] {
            let found = fields_of(
                json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
                "tables": {"lines": {"columns": bad}}}),
            );
            assert_eq!(found, vec!["tables.lines.columns".to_string()]);
        }
        let none = fields_of(
            json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "tables": {"lines": {"label": "Lines"}}}),
        );
        assert_eq!(none, vec!["tables.lines.columns".to_string()]);
        assert_eq!(
            fields_of(
                json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
                "tables": ["lines"]})
            ),
            vec!["tables".to_string()]
        );
    }

    #[test]
    fn a_column_adds_up_only_the_way_its_kind_can() {
        let ok = judged(with_columns(json!({
            "n": {"type": "number", "adds_up": "average"},
            "i": {"type": "integer", "adds_up": "max"},
            "d": {"type": "date", "adds_up": "min"},
            "t": {"type": "datetime", "adds_up": "max"},
            "s": {"type": "string", "adds_up": "count"},
            "b": {"type": "boolean", "adds_up": "count"},
            "r": {"type": "item", "adds_up": "count"}
        })));
        assert!(ok.is_ok(), "{:?}", ok.err());
        let found = fields_of(with_columns(json!({
            "s": {"type": "string", "adds_up": "sum"},
            "d": {"type": "date", "adds_up": "average"},
            "b": {"type": "boolean", "adds_up": "max"},
            "n": {"type": "number", "adds_up": "total"},
            "z": {"type": "number", "adds_up": 3},
            "y": {"type": "number", "adds_up": null}
        })));
        for column in ["s", "d", "b", "n", "z", "y"] {
            assert!(
                found.contains(&format!("tables.lines.columns.{column}.adds_up")),
                "{column}: {found:?}"
            );
        }
    }

    #[test]
    fn only_a_column_that_holds_text_can_be_searched() {
        for kind in ["string", "email", "url"] {
            let ok = judged(with_columns(
                json!({"x": {"type": kind, "searchable": true}}),
            ));
            assert!(ok.is_ok(), "{kind}: {:?}", ok.err());
        }
        let found = fields_of(with_columns(json!({
            "n": {"type": "number", "searchable": true},
            "r": {"type": "item", "searchable": true},
            "w": {"type": "string", "searchable": "yes"}
        })));
        for column in ["n", "r", "w"] {
            assert!(
                found.contains(&format!("tables.lines.columns.{column}.searchable")),
                "{column}: {found:?}"
            );
        }
    }

    #[test]
    fn an_item_column_names_registered_types_and_takes_no_value_rules() {
        let own = judged(
            json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "tables": {"lines": {"columns": {"mine": {"type": "item", "type_constraints": ["user.ledger"]}}}}}),
        );
        assert!(own.is_ok(), "{:?}", own.err());
        let found = fields_of(with_columns(json!({
            "a": {"type": "item", "type_constraints": ["user.missing"]},
            "b": {"type": "item", "type_constraints": []},
            "c": {"type": "item", "type_constraints": "user.file"},
            "d": {"type": "item", "type_constraints": [7]},
            "e": {"type": "item", "maxLength": 3},
            "f": {"type": "string", "type_constraints": ["user.file"]}
        })));
        for field in [
            "tables.lines.columns.a.type_constraints",
            "tables.lines.columns.b.type_constraints",
            "tables.lines.columns.c.type_constraints",
            "tables.lines.columns.d.type_constraints",
            "tables.lines.columns.e.maxLength",
            "tables.lines.columns.f.type_constraints",
        ] {
            assert!(found.iter().any(|f| f == field), "{field}: {found:?}");
        }
    }

    #[test]
    fn a_column_keeps_the_rules_a_field_of_its_kind_keeps() {
        let found = fields_of(with_columns(json!({
            "e": {"type": "enum"},
            "n": {"type": "number", "minimum": 5, "maximum": 1},
            "r": {"type": "string", "required": "yes"},
            "l": {"type": "string", "label": 7}
        })));
        for field in [
            "tables.lines.columns.e.enum_values",
            "tables.lines.columns.n.minimum",
            "tables.lines.columns.r.required",
            "tables.lines.columns.l.label",
        ] {
            assert!(found.iter().any(|f| f == field), "{field}: {found:?}");
        }
    }

    #[test]
    fn tables_and_columns_are_bounded() {
        let many_tables: serde_json::Map<String, Value> = (0..=super::MAX_TABLES_PER_TYPE)
            .map(|n| {
                (
                    format!("t{n}"),
                    json!({"columns": {"x": {"type": "string"}}}),
                )
            })
            .collect();
        let found = fields_of(
            json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
            "tables": many_tables}),
        );
        assert_eq!(found, vec!["tables".to_string()]);
        let at_most: serde_json::Map<String, Value> = (0..super::MAX_TABLES_PER_TYPE)
            .map(|n| {
                (
                    format!("t{n}"),
                    json!({"columns": {"x": {"type": "string"}}}),
                )
            })
            .collect();
        assert!(
            judged(
                json!({"id": "user.ledger", "fields": {"title": {"type": "string"}},
                "tables": at_most})
            )
            .is_ok()
        );
        let many_columns: serde_json::Map<String, Value> = (0..=super::MAX_COLUMNS_PER_TABLE)
            .map(|n| (format!("c{n}"), json!({"type": "string"})))
            .collect();
        assert_eq!(
            fields_of(with_columns(Value::Object(many_columns))),
            vec!["tables.lines.columns".to_string()]
        );
        let all_columns: serde_json::Map<String, Value> = (0..super::MAX_COLUMNS_PER_TABLE)
            .map(|n| (format!("c{n}"), json!({"type": "string"})))
            .collect();
        assert!(judged(with_columns(Value::Object(all_columns))).is_ok());
    }

    #[test]
    fn a_subtype_gets_its_parent_s_tables_and_may_not_change_one() {
        let held = registry();
        let resolved = resolve(&held, "user.base", false).unwrap().unwrap();
        assert_eq!(
            resolved["tables"]["entries"]["columns"]["note"]["label"],
            "Note"
        );
        let child = judged(json!({"id": "user.child", "parent": "user.base",
            "fields": {}, "tables": {"extra": {"columns": {"x": {"type": "integer"}}}}}))
        .unwrap_or_default();
        assert_eq!(child["tables"].as_object().map(|t| t.len()), Some(1));
        let with_child = held.with(child);
        let seen = resolve(&with_child, "user.child", false).unwrap().unwrap();
        let mut names: Vec<&str> = seen["tables"]
            .as_object()
            .map(|t| t.keys().map(String::as_str).collect())
            .unwrap_or_default();
        names.sort_unstable();
        assert_eq!(names, vec!["entries", "extra"]);

        let changed = judged(
            json!({"id": "user.child", "parent": "user.base", "fields": {},
            "tables": {"entries": {"columns": {"other": {"type": "string"}}}}}),
        )
        .err()
        .unwrap_or_default();
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert_eq!(changed[0].field, "tables.entries");
        assert_eq!(changed[0].code, Some("inheritance_violation"));
    }

    #[test]
    fn attaching_a_type_to_an_ancestor_is_judged_against_every_descendant() {
        let held = Registry::new(
            [
                json!({"id": "user.top", "version": 0, "fields": {"title": {"type": "string"}},
                       "tables": {"lines": {"columns": {"a": {"type": "string"}}}}}),
                json!({"id": "user.mid", "version": 0, "fields": {"title": {"type": "string"}}}),
                json!({"id": "user.leaf", "version": 0, "parent": "user.mid",
                       "fields": {}, "tables": {"lines": {"columns": {"b": {"type": "number"}}}}}),
            ]
            .into_iter()
            .filter_map(|row| row.as_object().cloned()),
        );
        let found = validate_type(
            &json!({"id": "user.mid", "parent": "user.top", "fields": {"title": {"type": "string"}}}),
            &held,
        )
        .err()
        .unwrap_or_default();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].field, "parent");
        assert_eq!(found[0].code, Some("inheritance_violation"));
        let same = Registry::new(
            [
                json!({"id": "user.top", "version": 0, "fields": {"title": {"type": "string"}},
                       "tables": {"lines": {"columns": {"a": {"type": "string"}}}}}),
                json!({"id": "user.mid", "version": 0, "fields": {"title": {"type": "string"}}}),
                json!({"id": "user.leaf", "version": 0, "parent": "user.mid",
                       "fields": {}, "tables": {"other": {"columns": {"b": {"type": "number"}}}}}),
            ]
            .into_iter()
            .filter_map(|row| row.as_object().cloned()),
        );
        let attached = validate_type(
            &json!({"id": "user.mid", "parent": "user.top", "fields": {"title": {"type": "string"}}}),
            &same,
        );
        assert!(attached.is_ok(), "{:?}", attached.err());
    }

    #[test]
    fn restating_an_inherited_table_exactly_as_read_is_not_stored_again() {
        let held = registry();
        let read = resolve(&held, "user.base", false).unwrap().unwrap();
        let stored = judged(
            json!({"id": "user.child", "parent": "user.base", "fields": {},
            "tables": read["tables"].clone()}),
        )
        .unwrap_or_default();
        assert!(!stored.contains_key("tables"), "{stored:?}");
    }

    #[test]
    fn a_parent_may_not_take_a_table_a_subtype_already_declares() {
        let held = registry().with(
            json!({"id": "user.child", "parent": "user.base", "fields": {},
                "tables": {"later": {"columns": {"x": {"type": "string"}}}}})
            .as_object()
            .cloned()
            .unwrap_or_default(),
        );
        let found = validate_type(
            &json!({"id": "user.base", "fields": {"title": {"type": "string"}},
                "tables": {"later": {"columns": {"y": {"type": "string"}}}}}),
            &held,
        )
        .err()
        .unwrap_or_default();
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].field, "tables.later");
        assert_eq!(found[0].code, Some("inheritance_violation"));
    }

    #[test]
    fn a_declared_read_makes_no_label_and_a_canonical_form_writes_the_defaults_down() {
        let held = registry();
        let declared = resolve(&held, "user.base", true).unwrap().unwrap();
        assert!(
            declared["tables"]["entries"]["columns"]["note"]
                .get("label")
                .is_none()
        );
        let canonical = super::super::canonical(declared);
        assert_eq!(
            canonical["tables"]["entries"]["columns"]["note"],
            json!({"type": "string", "required": false, "searchable": false})
        );
    }

    #[test]
    fn a_table_written_back_as_read_keeps_the_labels_it_never_had() {
        let held = registry();
        let stored = held.get("user.base").cloned().unwrap_or_default();
        let read = resolve(&held, "user.base", false).unwrap().unwrap();
        let submitted = judged(
            json!({"id": "user.base", "fields": {"title": {"type": "string"}},
            "tables": read["tables"].clone()}),
        )
        .unwrap_or_default();
        let out = super::super::read_back_free(submitted, &stored, Some(&read), None);
        assert_eq!(out["tables"]["entries"]["label"], "Entries");
        assert!(
            out["tables"]["entries"]["columns"]["note"]
                .get("label")
                .is_none()
        );
    }

    fn evolved(stored: Value, next: Value) -> (Vec<String>, Vec<String>) {
        let stored = judged(stored).unwrap_or_default();
        let next = judged(next).unwrap_or_default();
        evolution_of(&stored, &next)
    }

    fn ledger(tables: Value) -> Value {
        json!({"id": "user.ledger", "fields": {"title": {"type": "string"}}, "tables": tables})
    }

    #[test]
    fn adding_a_table_or_an_optional_column_is_free() {
        let before = ledger(json!({"lines": {"columns": {"a": {"type": "string"}}}}));
        let more_columns = ledger(json!({"lines": {"label": "Lines", "description": "d",
            "columns": {"a": {"type": "string", "label": "A", "description": "x"},
                        "b": {"type": "number", "adds_up": "sum"}}}}));
        assert_eq!(evolved(before.clone(), more_columns), (vec![], vec![]));
        let more_tables = ledger(json!({"lines": {"columns": {"a": {"type": "string"}}},
            "other": {"columns": {"z": {"type": "string", "required": true}}}}));
        assert_eq!(evolved(before, more_tables), (vec![], vec![]));
        let none = json!({"id": "user.ledger", "fields": {"title": {"type": "string"}}});
        let first = ledger(json!({"lines": {"columns": {"a": {"type": "string"}}}}));
        assert_eq!(evolved(none, first), (vec![], vec![]));
    }

    #[test]
    fn changing_a_kind_requiring_a_column_or_removing_one_needs_a_schema_writer() {
        let before = ledger(json!({"lines": {"columns": {
            "a": {"type": "string"}, "b": {"type": "string"}}}}));
        let kind = ledger(json!({"lines": {"columns": {
            "a": {"type": "number"}, "b": {"type": "string"}}}}));
        assert_eq!(
            evolved(before.clone(), kind).0,
            vec!["tables.lines.columns.a".to_string()]
        );
        let required = ledger(json!({"lines": {"columns": {
            "a": {"type": "string", "required": true}, "b": {"type": "string"}}}}));
        assert_eq!(
            evolved(before.clone(), required).0,
            vec!["tables.lines.columns.a".to_string()]
        );
        let new_required = ledger(json!({"lines": {"columns": {
            "a": {"type": "string"}, "b": {"type": "string"}, "c": {"type": "string", "required": true}}}}));
        assert_eq!(
            evolved(before.clone(), new_required).0,
            vec!["tables.lines.columns.c".to_string()]
        );
        let fewer = ledger(json!({"lines": {"columns": {"a": {"type": "string"}}}}));
        assert_eq!(
            evolved(before.clone(), fewer).0,
            vec!["tables.lines.columns.b".to_string()]
        );
        let dropped = json!({"id": "user.ledger", "fields": {"title": {"type": "string"}}});
        assert_eq!(evolved(before, dropped).0, vec!["tables.lines".to_string()]);
    }
}
