//! Cases for the rules that judge a shipped type or edge type, in the form they take when a definition is registered.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::catalog_file::{definitions, register_edges, register_types, shipped_sources};
use crate::schema::{
    EdgeIssues, Issue, Judging, Obj, Registry, edge_type_from_request, labelled, request_shape,
    unread_edge_keys, unread_keys, validate_type,
};

fn row(value: Value) -> Obj {
    match value {
        Value::Object(row) => row,
        other => panic!("{other} is not an object"),
    }
}

fn shipped_rows() -> Vec<Obj> {
    let (types, _) = shipped_sources(&definitions()).unwrap_or_else(|e| panic!("{e}"));
    types.into_iter().map(|(_, row)| row).collect()
}

/// The shipped types as a server holds them once registered, with the types in `extra` as registered after them.
fn registry_with(extra: &[Value]) -> Registry {
    let (types, _) = shipped_sources(&definitions()).unwrap_or_else(|e| panic!("{e}"));
    let held = register_types(&types).unwrap_or_else(|e| panic!("{}", e.join("\n")));
    let mut registry = Registry::new(held.into_iter().map(|held| labelled(held.stored)));
    for definition in extra {
        let stored = accepted(definition.clone(), &registry);
        registry = registry.with(labelled(stored));
    }
    registry
}

fn accepted(input: Value, registry: &Registry) -> Obj {
    validate_type(&input, registry).unwrap_or_else(|issues| {
        panic!(
            "{input} was refused: {:?}",
            issues
                .iter()
                .map(|i| format!("{}: {}", i.field, i.message()))
                .collect::<Vec<_>>()
        )
    })
}

fn refused(input: Value, registry: &Registry) -> Vec<Issue> {
    match validate_type(&input, registry) {
        Ok(stored) => panic!("{input} was accepted as {stored:?}"),
        Err(issues) => issues,
    }
}

fn fields_of(issues: &[Issue]) -> Vec<&str> {
    issues.iter().map(|issue| issue.field.as_str()).collect()
}

fn coded(issues: &[Issue], field: &str, code: &str) -> bool {
    issues
        .iter()
        .any(|issue| issue.field == field && issue.code == Some(code))
}

fn edge(input: Value) -> Result<Obj, EdgeIssues> {
    let body = row(input);
    request_shape(&body)?;
    edge_type_from_request(&body, &|_| None, Judging::Register)
}

fn edge_field(refusal: &EdgeIssues) -> Option<String> {
    match refusal {
        EdgeIssues::Validation { field, .. } => field.clone(),
        EdgeIssues::Missing { field } => Some((*field).to_string()),
        EdgeIssues::Schema(issues) => issues.first().map(|issue| issue.field.clone()),
        EdgeIssues::Conflict { .. } => None,
    }
}

const WORDS: [(&str, &str); 4] = [
    ("todo", "not_started"),
    ("doing", "in_progress"),
    ("done", "completed"),
    ("dropped", "canceled"),
];

fn words(list: &[(&str, &str)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(value, group)| json!({"value": value, "group": group}))
            .collect(),
    )
}

fn work_item() -> Value {
    json!({"id": "acme.work", "fields": {
        "title": {"type": "string"},
        "stage": {"type": "status", "status_values": words(&WORDS)}
    }})
}

mod status {
    use super::*;

    #[test]
    fn a_status_field_takes_words_in_the_four_groups_and_keeps_their_order() {
        let stored = accepted(work_item(), &registry_with(&[]));
        assert_eq!(
            stored["fields"]["stage"],
            json!({"type": "status", "status_values": words(&WORDS)})
        );
    }

    #[test]
    fn a_status_field_refuses_each_malformed_definition_naming_the_member() {
        let cases = [
            (
                "no words",
                json!({"type": "status"}),
                "fields.stage.status_values",
            ),
            (
                "an empty list",
                json!({"type": "status", "status_values": []}),
                "fields.stage.status_values",
            ),
            (
                "a group outside the four",
                json!({"type": "status", "status_values": [{"value": "todo", "group": "waiting"}]}),
                "fields.stage.status_values.0.group",
            ),
            (
                "a word outside the grammar",
                json!({"type": "status", "status_values": [{"value": "In Review", "group": "in_progress"}]}),
                "fields.stage.status_values.0.value",
            ),
            (
                "a repeated word",
                json!({"type": "status", "status_values": [
                    {"value": "todo", "group": "not_started"},
                    {"value": "todo", "group": "in_progress"}]}),
                "fields.stage.status_values.1.value",
            ),
            (
                "an entry with another key",
                json!({"type": "status", "status_values": [
                    {"value": "todo", "group": "not_started", "label": "To do"}]}),
                "fields.stage.status_values.0",
            ),
            (
                "enum_values in place of words",
                json!({"type": "status", "status_values": words(&WORDS), "enum_values": ["todo"]}),
                "fields.stage.enum_values",
            ),
            (
                "status_values on a field of another kind",
                json!({"type": "string", "status_values": words(&WORDS)}),
                "fields.stage.status_values",
            ),
            (
                "an array of status words",
                json!({"type": "array", "items_type": "status"}),
                "fields.stage.items_type",
            ),
        ];
        for (what, stage, path) in cases {
            let issues = refused(
                json!({"id": "acme.bad", "fields": {"stage": stage}}),
                &registry_with(&[]),
            );
            assert!(fields_of(&issues).contains(&path), "{what}: {issues:?}");
        }
    }

    #[test]
    fn a_second_status_field_in_one_type_is_refused_at_the_second() {
        let issues = refused(
            json!({"id": "acme.bad", "fields": {
                "stage": {"type": "status", "status_values": words(&WORDS)},
                "phase": {"type": "status", "status_values": words(&WORDS)}}}),
            &registry_with(&[]),
        );
        assert!(
            fields_of(&issues).contains(&"fields.phase.type"),
            "{issues:?}"
        );
    }

    #[test]
    fn a_subtype_redeclares_the_status_field_to_require_it_without_words() {
        let held = registry_with(&[work_item()]);
        accepted(
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {
                "stage": {"type": "status", "required": true}}}),
            &held,
        );
        accepted(
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {
                "stage": {"type": "status", "status_values": [{"value": "blocked", "group": "in_progress"}]}}}),
            &held,
        );
    }

    #[test]
    fn a_subtype_joins_its_new_words_after_the_inherited_ones_each_with_its_group() {
        let held = registry_with(&[
            work_item(),
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {
                "stage": {"type": "status", "status_values": [{"value": "blocked", "group": "in_progress"}]}}}),
        ]);
        let resolved = crate::schema::resolve(&held, "acme.bug", false)
            .unwrap()
            .unwrap();
        let found: Vec<(&str, &str)> = resolved["fields"]["stage"]["status_values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|word| {
                (
                    word["value"].as_str().unwrap(),
                    word["group"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                ("todo", "not_started"),
                ("doing", "in_progress"),
                ("done", "completed"),
                ("dropped", "canceled"),
                ("blocked", "in_progress"),
            ]
        );
    }

    #[test]
    fn a_subtype_may_not_repeat_an_inherited_word_add_a_second_status_or_change_the_kind() {
        let held = registry_with(&[work_item()]);
        let repeated = refused(
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {
                "stage": {"type": "status", "status_values": [{"value": "done", "group": "canceled"}]}}}),
            &held,
        );
        assert!(
            coded(
                &repeated,
                "fields.stage.status_values",
                "inheritance_violation"
            ),
            "{repeated:?}"
        );
        let second = refused(
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {
                "phase": {"type": "status", "status_values": words(&WORDS)}}}),
            &held,
        );
        assert!(
            coded(&second, "fields.phase", "inheritance_violation"),
            "{second:?}"
        );
        let kind = refused(
            json!({"id": "acme.bug", "parent": "acme.work", "fields": {"stage": {"type": "string"}}}),
            &held,
        );
        assert!(
            kind.iter().any(|i| i.code == Some("inheritance_violation")),
            "{kind:?}"
        );
    }

    #[test]
    fn compatible_with_reads_a_status_field_as_a_string_or_as_a_status_field_in_the_same_groups() {
        let mut with_work = work_item();
        with_work["id"] = json!("acme.work2");
        let text = json!({"id": "acme.text", "fields": {"stage": {"type": "string"}}});
        let wide = json!({"id": "acme.wide", "fields": {"stage": {"type": "status",
            "status_values": words(&[WORDS[0], WORDS[1], WORDS[2], WORDS[3], ("blocked", "in_progress")])}}});
        for (target, id) in [(&text, "acme.text"), (&wide, "acme.wide")] {
            let mut claim = with_work.clone();
            claim["compatible_with"] = json!([id]);
            accepted(claim, &registry_with(std::slice::from_ref(target)));
        }
        for (what, narrow) in [
            ("a word the target lacks", words(&WORDS[..3])),
            (
                "a word the target puts in another group",
                words(&[WORDS[0], WORDS[1], WORDS[2], ("dropped", "completed")]),
            ),
        ] {
            let target = json!({"id": "acme.narrow", "fields": {"stage": {"type": "status", "status_values": narrow}}});
            let mut claim = with_work.clone();
            claim["compatible_with"] = json!(["acme.narrow"]);
            let issues = refused(claim, &registry_with(&[target]));
            assert!(
                issues
                    .iter()
                    .any(|i| i.code == Some("compatible_with_violation")),
                "{what}: {issues:?}"
            );
        }
        let issues = refused(
            json!({"id": "acme.loose", "fields": {"stage": {"type": "string"}}, "compatible_with": ["acme.wide"]}),
            &registry_with(&[wide]),
        );
        assert!(
            issues
                .iter()
                .any(|i| i.code == Some("compatible_with_violation")),
            "{issues:?}"
        );
    }

    #[test]
    fn core_task_declares_its_status_in_the_four_groups_without_pending() {
        let task = shipped_rows()
            .into_iter()
            .find(|row| row["id"] == "core.task")
            .unwrap();
        assert_eq!(
            task["fields"]["status"],
            json!({
                "type": "status",
                "description": "Where the task stands",
                "status_values": words(&[
                    ("not_started", "not_started"),
                    ("in_progress", "in_progress"),
                    ("completed", "completed"),
                    ("canceled", "canceled"),
                ])
            })
        );
    }
}

mod thumbnail {
    use super::*;

    fn parent() -> Value {
        json!({"id": "acme.photo", "version": 1, "fields": {"thumbnail": {"type": "thumbnail"}}})
    }

    #[test]
    fn a_thumbnail_is_declared_by_its_type_or_by_the_format_and_stored_one_way() {
        let held = registry_with(&[parent()]);
        for declared in [
            json!({"type": "thumbnail"}),
            json!({"type": "string", "format": "thumbnail"}),
        ] {
            let stored = accepted(
                json!({"id": "acme.a", "fields": {"cover": declared}}),
                &held,
            );
            assert_eq!(stored["fields"]["cover"], json!({"type": "thumbnail"}));
        }
    }

    #[test]
    fn a_thumbnail_is_never_a_title_or_a_body_and_never_an_edge_property() {
        let held = registry_with(&[parent()]);
        for hint in ["title_field", "body_field"] {
            let issues = refused(
                json!({"id": "acme.hinted", "fields": {"cover": {"type": "thumbnail"}, "caption": {"type": "string"}},
                       "display_hints": {hint: "cover"}}),
                &held,
            );
            assert!(!issues.is_empty(), "{hint}");
        }
        accepted(
            json!({"id": "acme.hinted", "fields": {"cover": {"type": "thumbnail"}, "caption": {"type": "string"}},
                   "display_hints": {"title_field": "caption"}}),
            &held,
        );
        assert!(
            edge(
                json!({"id": "depicts", "label": "Test label", "cardinality": "many-to-many",
                        "property_schema": {"preview": {"type": "thumbnail"}}})
            )
            .is_err()
        );
        assert!(
            edge(
                json!({"id": "depicts", "label": "Test label", "cardinality": "many-to-many",
                        "property_schema": {"note": {"type": "string"}}})
            )
            .is_ok()
        );
    }

    #[test]
    fn an_inherited_thumbnail_is_never_named_by_a_hint() {
        let held = registry_with(&[parent()]);
        accepted(
            json!({"id": "acme.photo.raw", "parent": "acme.photo", "fields": {"caption": {"type": "string"}},
                   "display_hints": {"title_field": "caption"}}),
            &held,
        );
        for hint in ["title_field", "body_field"] {
            let issues = refused(
                json!({"id": "acme.photo.raw", "parent": "acme.photo", "fields": {"caption": {"type": "string"}},
                       "display_hints": {hint: "thumbnail"}}),
                &held,
            );
            assert_eq!(issues[0].field, format!("display_hints.{hint}"));
        }
    }

    #[test]
    fn a_thumbnail_is_never_an_arrays_element_type_on_a_type_or_an_edge() {
        let held = registry_with(&[]);
        accepted(
            json!({"id": "acme.album", "fields": {"labels": {"type": "array", "items_type": "string"}}}),
            &held,
        );
        assert!(
            edge(
                json!({"id": "depicts", "label": "Test label", "cardinality": "many-to-many",
                        "property_schema": {"labels": {"type": "array", "items_type": "string"}}})
            )
            .is_ok()
        );
        for name in ["covers", "title"] {
            let issues = refused(
                json!({"id": "acme.album", "fields": {name: {"type": "array", "items_type": "thumbnail"}}}),
                &held,
            );
            assert_eq!(issues[0].field, format!("fields.{name}.items_type"));
        }
        assert!(
            edge(json!({"id": "depicts", "label": "Test label", "cardinality": "many-to-many",
                        "property_schema": {"previews": {"type": "array", "items_type": "thumbnail"}}}))
            .is_err()
        );
    }

    #[test]
    fn a_thumbnail_is_refused_beside_one_the_type_inherits() {
        let held = registry_with(&[parent()]);
        accepted(
            json!({"id": "acme.photo.raw", "parent": "acme.photo", "fields": {"camera": {"type": "string"}}}),
            &held,
        );
        let issues = refused(
            json!({"id": "acme.photo.raw", "parent": "acme.photo", "fields": {"preview": {"type": "thumbnail"}}}),
            &held,
        );
        assert_eq!(issues[0].field, "fields.preview");
        assert!(
            issues[0]
                .actual
                .contains("\"thumbnail\" from \"acme.photo\""),
            "{}",
            issues[0].actual
        );
    }
}

mod display_icon {
    use super::*;

    fn base() -> Value {
        json!({"id": "acme.base", "version": 1,
               "fields": {"name": {"type": "string"}, "text": {"type": "string"}},
               "display_hints": {"title_field": "name"}})
    }

    fn with_hints(hints: Value) -> Value {
        json!({"id": "acme.thing", "fields": {"name": {"type": "string"}}, "display_hints": hints})
    }

    fn lucide() -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon-set-lucide.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn an_icon_id_from_each_accepted_set_is_kept_beside_the_other_hints() {
        let held = registry_with(&[base()]);
        for icon in ["lucide:calendar", "simple-icons:github"] {
            let stored = accepted(
                with_hints(json!({"title_field": "name", "icon": icon})),
                &held,
            );
            assert_eq!(
                stored["display_hints"],
                json!({"title_field": "name", "icon": icon})
            );
        }
    }

    #[test]
    fn an_icon_alone_is_taken_where_the_hints_above_it_name_the_title() {
        accepted(
            json!({"id": "acme.base.thing", "parent": "acme.base", "fields": {}, "display_hints": {"icon": "lucide:box"}}),
            &registry_with(&[base()]),
        );
    }

    #[test]
    fn anything_but_an_id_from_a_pinned_sets_icons_is_refused_naming_the_member() {
        let held = registry_with(&[base()]);
        let set = lucide();
        let alias = set["aliases"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let aliased = format!("lucide:{alias}");
        let refused_icons = [
            "calendar",
            "github",
            "lucide:Calendar",
            "Lucide:calendar",
            "lucide:calendar_days",
            "lucide:not-an-icon",
            "lucide:github",
            "simple-icons:calendar",
            aliased.as_str(),
            "mdi:calendar",
            "lucide:",
            ":calendar",
            "lucide:calendar:days",
            " lucide:calendar",
            "lucide:calendar ",
            "",
        ];
        for icon in refused_icons {
            let issues = refused(with_hints(json!({"icon": icon})), &held);
            assert_eq!(
                fields_of(&issues),
                ["display_hints.icon"],
                "\"{icon}\" was taken"
            );
        }
        accepted(with_hints(json!({"icon": "lucide:calendar-days"})), &held);
        accepted(with_hints(json!({"icon": "simple-icons:github"})), &held);
    }

    #[test]
    fn a_bare_name_is_told_which_id_to_send() {
        let issues = refused(
            with_hints(json!({"icon": "calendar-days"})),
            &registry_with(&[]),
        );
        assert!(
            issues[0].hint.contains("\"lucide:calendar-days\""),
            "{}",
            issues[0].hint
        );
    }

    #[test]
    fn an_icon_that_is_not_text_is_refused() {
        for icon in [
            json!(3),
            json!(null),
            json!(["lucide:calendar"]),
            json!({"name": "calendar"}),
        ] {
            refused(with_hints(json!({"icon": icon})), &registry_with(&[]));
        }
    }

    #[test]
    fn the_other_hints_are_still_judged_beside_an_icon() {
        let issues = refused(
            with_hints(
                json!({"title_field": "missing", "body_field": "text", "icon": "lucide:box"}),
            ),
            &registry_with(&[base()]),
        );
        let mut found = fields_of(&issues);
        found.sort_unstable();
        assert_eq!(
            found,
            ["display_hints.body_field", "display_hints.title_field"]
        );
    }

    #[test]
    fn the_shipped_types_icons_are_each_a_lucide_icon_the_set_lists() {
        let held = registry_with(&[]);
        let used: Vec<(String, String)> = shipped_rows()
            .iter()
            .filter_map(|row| {
                let icon = row.get("display_hints")?.get("icon")?.as_str()?;
                Some((row["id"].as_str()?.to_string(), icon.to_string()))
            })
            .collect();
        assert!(used.len() > 20, "{}", used.len());
        for (id, icon) in used {
            accepted(
                json!({"id": "acme.thing", "fields": {}, "display_hints": {"icon": icon}}),
                &held,
            );
            assert!(icon.starts_with("lucide:"), "{id} uses {icon}");
        }
    }

    #[test]
    fn each_icon_set_lists_each_name_once_in_kebab_case_with_no_alias_among_them() {
        for file in ["icon-set-lucide.json", "icon-set-simple-icons.json"] {
            let set: Value = serde_json::from_str(
                &std::fs::read_to_string(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("icons")
                        .join(file),
                )
                .unwrap(),
            )
            .unwrap();
            let icons: Vec<&str> = set["icons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap())
                .collect();
            let unique: BTreeSet<&str> = icons.iter().copied().collect();
            assert_eq!(unique.len(), icons.len(), "{file} lists a name twice");
            assert!(
                icons.windows(2).all(|pair| pair[0] < pair[1]),
                "{file} is not sorted"
            );
            for name in &icons {
                let kebab = !name.is_empty()
                    && name.split('-').all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                    });
                assert!(kebab, "{file}: {name}");
            }
            let aliases = set["aliases"].as_object().unwrap();
            assert!(!aliases.is_empty(), "{file} keeps no alias");
            for (alias, icon) in aliases {
                assert!(
                    !unique.contains(alias.as_str()),
                    "{file}: {alias} is an icon and an alias"
                );
                assert!(
                    unique.contains(icon.as_str().unwrap()),
                    "{file}: {alias} names {icon}, which is not listed"
                );
            }
        }
    }

    #[test]
    fn each_icon_set_is_the_package_and_version_its_pin_names() {
        let pins = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/icon-sets.txt"),
        )
        .unwrap();
        let pinned: Vec<(&str, &str)> = pins
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .map(|line| {
                let mut parts = line.split_whitespace();
                (parts.next().unwrap(), parts.next().unwrap())
            })
            .collect();
        assert_eq!(
            pinned.iter().map(|(prefix, _)| *prefix).collect::<Vec<_>>(),
            ["lucide", "simple-icons"]
        );
        for (prefix, version) in pinned {
            let set: Value = serde_json::from_str(
                &std::fs::read_to_string(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join(format!("icons/icon-set-{prefix}.json")),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(set["prefix"], prefix);
            assert_eq!(set["package"], format!("@iconify-json/{prefix}"));
            assert_eq!(set["version"], version);
        }
    }
}

mod policies {
    use super::*;

    fn declare(field: &str, policy: Value, id: &str) -> Result<Obj, Vec<Issue>> {
        validate_type(
            &json!({"id": id, "fields": {"title": {"type": "string"}}, field: policy}),
            &Registry::default(),
        )
    }

    fn refused_at(field: &str, policy: Value, id: &str) -> Vec<String> {
        declare(field, policy, id)
            .err()
            .unwrap_or_else(|| panic!("{field} {id} was taken"))
            .into_iter()
            .map(|issue| issue.field)
            .collect()
    }

    #[test]
    fn a_retention_policy_takes_whole_days_from_1_to_the_maximum_null_or_nothing() {
        for policy in [
            json!({"feed_days": 1}),
            json!({"feed_days": 30}),
            json!({"feed_days": 36_500}),
            json!({"feed_days": null}),
            json!({}),
        ] {
            let stored = declare("retention_policy", policy.clone(), "acme.feed")
                .unwrap_or_else(|e| panic!("{policy}: {e:?}"));
            assert_eq!(stored["retention_policy"], policy);
        }
    }

    #[test]
    fn a_type_that_declares_no_retention_policy_stores_none() {
        let stored = accepted(
            json!({"id": "acme.feed", "fields": {"title": {"type": "string"}}}),
            &Registry::default(),
        );
        assert!(!stored.contains_key("retention_policy"));
    }

    #[test]
    fn a_retention_policy_refuses_a_feed_days_that_is_not_a_whole_number_in_range_naming_the_field()
    {
        for bad in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("30"),
            json!(true),
            json!([]),
            json!({}),
            json!(36_501),
            json!(9_007_199_254_740_991_i64),
        ] {
            assert_eq!(
                refused_at("retention_policy", json!({"feed_days": bad}), "acme.feed"),
                ["retention_policy.feed_days"],
                "{bad}"
            );
        }
    }

    #[test]
    fn a_retention_policy_that_is_not_an_object_is_refused_at_the_policy() {
        for bad in [json!(30), json!("30"), json!(null), json!([]), json!(true)] {
            assert_eq!(
                refused_at("retention_policy", bad.clone(), "acme.feed"),
                ["retention_policy"],
                "{bad}"
            );
        }
    }

    #[test]
    fn a_system_type_takes_no_retention_policy_and_the_same_policy_passes_elsewhere() {
        assert_eq!(
            refused_at("retention_policy", json!({"feed_days": 30}), "system.thing"),
            ["retention_policy"]
        );
        assert_eq!(
            refused_at("retention_policy", json!({}), "system.thing"),
            ["retention_policy"]
        );
        assert!(declare("retention_policy", json!({"feed_days": 30}), "acme.thing").is_ok());
    }

    #[test]
    fn a_version_policy_takes_whole_numbers_in_range_windows_in_order_and_any_part_left_out() {
        for policy in [
            json!({"max_versions": 1}),
            json!({"max_versions": 1_000_000}),
            json!({"recent_days": 7, "daily_snapshot_days": 30, "weekly_snapshot_days": 365}),
            json!({"recent_days": 30, "daily_snapshot_days": 30, "weekly_snapshot_days": 30}),
            json!({"recent_days": 0, "daily_snapshot_days": 0, "weekly_snapshot_days": 0}),
            json!({"recent_days": 0, "daily_snapshot_days": 36_500}),
            json!({"daily_snapshot_days": 30}),
            json!({}),
        ] {
            assert!(
                declare("version_policy", policy.clone(), "acme.policy").is_ok(),
                "{policy}"
            );
        }
    }

    #[test]
    fn a_version_policy_refuses_a_bad_number_for_every_window_and_for_max_versions_naming_the_field()
     {
        for key in ["recent_days", "daily_snapshot_days", "weekly_snapshot_days"] {
            for bad in [
                json!(-1),
                json!(1.5),
                json!("7"),
                json!(null),
                json!(36_501),
            ] {
                let found =
                    refused_at("version_policy", json!({ key: bad.clone() }), "acme.policy");
                assert!(
                    found.contains(&format!("version_policy.{key}")),
                    "{key} {bad}"
                );
            }
        }
        for bad in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("7"),
            json!(null),
            json!(1_000_001),
        ] {
            let found = refused_at(
                "version_policy",
                json!({"max_versions": bad.clone()}),
                "acme.policy",
            );
            assert!(
                found.contains(&"version_policy.max_versions".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_version_policy_refuses_windows_out_of_order_naming_the_one_that_ends_too_soon() {
        let at = |policy: Value| refused_at("version_policy", policy, "acme.policy");
        assert_eq!(
            at(json!({"recent_days": 30, "daily_snapshot_days": 7})),
            ["version_policy.daily_snapshot_days"]
        );
        assert_eq!(
            at(json!({"daily_snapshot_days": 90, "weekly_snapshot_days": 30})),
            ["version_policy.weekly_snapshot_days"]
        );
        assert_eq!(
            at(json!({"recent_days": 400, "weekly_snapshot_days": 365})),
            ["version_policy.weekly_snapshot_days"]
        );
        assert_eq!(
            at(json!({"recent_days": 1, "daily_snapshot_days": 0})),
            ["version_policy.daily_snapshot_days"]
        );
    }

    #[test]
    fn a_version_policy_holds_a_window_against_the_longest_one_before_it_not_only_the_last() {
        assert_eq!(
            refused_at(
                "version_policy",
                json!({"recent_days": 100, "daily_snapshot_days": 50, "weekly_snapshot_days": 70}),
                "acme.policy"
            ),
            [
                "version_policy.daily_snapshot_days",
                "version_policy.weekly_snapshot_days"
            ]
        );
    }
}

mod fields {
    use super::*;

    #[test]
    fn a_field_keeps_its_searchable_cap_and_annotation_attributes() {
        let stored = accepted(
            json!({"id": "acme.kitchen_sink", "version": 1, "fields": {
                "secret": {"type": "string", "searchable": false},
                "blurb": {"type": "string", "max_length": 280},
                "tags": {"type": "array", "items_type": "string", "max_items": 20},
                "language": {"type": "string", "format": "bcp47"},
                "country": {"type": "string", "format": "iso3166"}}}),
            &registry_with(&[]),
        );
        assert_eq!(stored["fields"]["secret"]["searchable"], false);
        assert_eq!(stored["fields"]["blurb"]["max_length"], 280);
        assert_eq!(stored["fields"]["tags"]["max_items"], 20);
        assert_eq!(stored["fields"]["language"]["format"], "bcp47");
        assert_eq!(stored["fields"]["country"]["format"], "iso3166");
    }

    #[test]
    fn a_format_that_has_a_kind_of_its_own_collapses_into_the_kind() {
        let stored = accepted(
            json!({"id": "acme.linky", "version": 1, "fields": {
                "href": {"type": "string", "format": "url"}, "seen_at": {"type": "datetime"}}}),
            &registry_with(&[]),
        );
        assert_eq!(stored["fields"]["href"]["type"], "url");
        assert!(stored["fields"]["href"].get("format").is_none());
        assert_eq!(stored["fields"]["seen_at"]["type"], "datetime");
    }

    #[test]
    fn datetime_is_refused_as_a_format_where_it_is_a_kind() {
        for field in [
            json!({"type": "string", "format": "datetime"}),
            json!({"type": "array", "items_type": "string", "format": "datetime"}),
        ] {
            let issues = refused(
                json!({"id": "acme.old_datetime", "version": 1, "fields": {"seen_at": field}}),
                &registry_with(&[]),
            );
            assert!(
                fields_of(&issues).contains(&"fields.seen_at.format"),
                "{field}: {issues:?}"
            );
        }
    }

    #[test]
    fn a_declared_list_of_strings_stays_a_list_of_the_formats_kind() {
        let stored = accepted(
            json!({"id": "acme.link_list", "version": 1, "fields": {
                "links": {"type": "array", "items_type": "string", "format": "url"},
                "days": {"type": "array", "items_type": "string", "format": "date"}}}),
            &registry_with(&[]),
        );
        assert_eq!(
            stored["fields"]["links"],
            json!({"type": "array", "items_type": "url"})
        );
        assert_eq!(
            stored["fields"]["days"],
            json!({"type": "array", "items_type": "date"})
        );
    }

    #[test]
    fn a_format_that_names_a_kind_the_declared_type_cannot_take_is_refused() {
        for field in [
            json!({"type": "number", "format": "url"}),
            json!({"type": "array", "items_type": "object", "format": "url"}),
            json!({"type": "array", "items_type": "string", "format": "thumbnail"}),
            json!({"type": "datetime", "format": "date"}),
        ] {
            let issues = refused(
                json!({"id": "acme.mismatched_format", "version": 1, "fields": {"value": field}}),
                &registry_with(&[]),
            );
            assert!(
                fields_of(&issues).contains(&"fields.value.format"),
                "{field}: {issues:?}"
            );
        }
    }

    #[test]
    fn a_field_is_required_by_the_top_level_array_or_by_the_field() {
        let held = registry_with(&[]);
        let via_array = accepted(
            json!({"id": "acme.via_array", "version": 1, "fields": {"title": {"type": "string"}}, "required": ["title"]}),
            &held,
        );
        let via_field = accepted(
            json!({"id": "acme.via_field", "version": 1, "fields": {"title": {"type": "string", "required": true}}}),
            &held,
        );
        assert_eq!(via_array["fields"]["title"]["required"], true);
        assert_eq!(via_field["fields"]["title"]["required"], true);
    }

    #[test]
    fn a_required_name_that_matches_no_field_is_refused() {
        let issues = refused(
            json!({"id": "acme.ghost_required", "version": 1, "fields": {"title": {"type": "string"}}, "required": ["subtitle"]}),
            &registry_with(&[]),
        );
        assert!(fields_of(&issues).contains(&"required"), "{issues:?}");
    }

    #[test]
    fn a_subtype_keeps_a_required_refinement_of_an_inherited_optional_field() {
        let stored = accepted(
            json!({"id": "acme.titled_note", "parent": "core.note", "version": 1,
                   "fields": {"sentiment": {"type": "string"}}, "required": ["title"]}),
            &registry_with(&[]),
        );
        assert_eq!(stored["fields"]["title"]["required"], true);
        assert_eq!(stored["fields"]["title"]["type"], "string");
    }

    #[test]
    fn a_type_that_names_no_version_is_at_0_and_0_is_a_version() {
        for input in [
            json!({"id": "acme.unversioned", "fields": {"title": {"type": "string"}}}),
            json!({"id": "acme.zero", "version": 0, "fields": {"title": {"type": "string"}}}),
        ] {
            assert_eq!(accepted(input, &registry_with(&[]))["version"], 0);
        }
    }
}

mod compatible_with {
    use super::*;

    fn violations(issues: &[Issue]) -> Vec<&str> {
        issues
            .iter()
            .filter(|issue| issue.code == Some("compatible_with_violation"))
            .map(|issue| issue.field.as_str())
            .collect()
    }

    #[test]
    fn a_claim_takes_the_array_form_the_string_shorthand_and_several_targets() {
        let held = registry_with(&[]);
        let stored = accepted(
            json!({"id": "acme.deal_note", "version": 1, "compatible_with": ["core.note"],
                   "fields": {"body": {"type": "string"}, "amount": {"type": "number"}}, "required": ["body"]}),
            &held,
        );
        assert_eq!(stored["compatible_with"], json!(["core.note"]));
        let shorthand = accepted(
            json!({"id": "acme.deal_note", "version": 1, "compatible_with": "core.note",
                   "fields": {"body": {"type": "string", "required": true}}}),
            &held,
        );
        assert_eq!(shorthand["compatible_with"], json!(["core.note"]));
        accepted(
            json!({"id": "acme.everything", "version": 1, "compatible_with": ["core.note", "core.bookmark"],
                   "fields": {"body": {"type": "string", "required": true}, "url": {"type": "url", "required": true}}}),
            &held,
        );
    }

    #[test]
    fn object_fields_compare_as_opaque_whatever_they_contain() {
        let held = registry_with(&[json!({"id": "acme.box", "version": 1,
            "fields": {"payload": {"type": "object", "required": true}}})]);
        accepted(
            json!({"id": "acme.crate", "version": 1, "compatible_with": ["acme.box"],
                   "fields": {"payload": {"type": "object", "required": true}}}),
            &held,
        );
    }

    #[test]
    fn a_claim_is_refused_where_the_target_requires_a_field_the_type_lacks() {
        let issues = refused(
            json!({"id": "acme.titleless", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"headline": {"type": "string"}}}),
            &registry_with(&[]),
        );
        assert!(
            violations(&issues).contains(&"compatible_with.core.task.title"),
            "{issues:?}"
        );
    }

    #[test]
    fn a_claim_is_refused_where_the_target_field_has_another_type_or_the_field_stays_optional() {
        let held = registry_with(&[]);
        let issues = refused(
            json!({"id": "acme.numeric_body", "version": 1, "compatible_with": ["core.note"],
                   "fields": {"body": {"type": "number", "required": true}}}),
            &held,
        );
        assert!(!violations(&issues).is_empty(), "{issues:?}");
        let issues = refused(
            json!({"id": "acme.optional_task", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"title": {"type": "string"}}}),
            &held,
        );
        assert!(
            violations(&issues).contains(&"compatible_with.core.task.title.required"),
            "{issues:?}"
        );
    }

    #[test]
    fn a_claim_holds_the_type_to_the_required_fields_its_target_inherits() {
        let issues = refused(
            json!({"id": "acme.partial_audio", "version": 1, "compatible_with": ["core.file.audio"],
                   "fields": {"duration": {"type": "number", "required": true}}}),
            &registry_with(&[]),
        );
        let found = violations(&issues);
        assert!(
            found.contains(&"compatible_with.core.file.audio.blob_ref"),
            "{issues:?}"
        );
        assert!(
            found.contains(&"compatible_with.core.file.audio.mime_type"),
            "{issues:?}"
        );
    }

    #[test]
    fn a_claim_is_met_by_required_fields_the_type_inherits() {
        accepted(
            json!({"id": "acme.annotated_note", "parent": "core.note", "version": 1,
                   "compatible_with": ["core.note"], "fields": {"sentiment": {"type": "string"}}}),
            &registry_with(&[]),
        );
    }

    #[test]
    fn a_claim_is_refused_for_incompatible_array_elements_and_enum_values_and_met_by_a_narrower_enum()
     {
        let held = registry_with(&[
            json!({"id": "acme.collection", "version": 1, "fields": {
                "tags": {"type": "array", "items_type": "string", "required": true},
                "workflow_stage": {"type": "enum", "enum_values": ["open", "closed"], "required": true}}}),
            json!({"id": "acme.workflow", "version": 1, "fields": {
                "workflow_stage": {"type": "enum", "enum_values": ["open", "closed"], "required": true}}}),
        ]);
        let issues = refused(
            json!({"id": "acme.unsafe_collection", "version": 1, "compatible_with": ["acme.collection"],
                   "fields": {"tags": {"type": "array", "items_type": "number", "required": true},
                              "workflow_stage": {"type": "enum", "enum_values": ["open", "closed", "deleted"], "required": true}}}),
            &held,
        );
        let found = violations(&issues);
        assert!(
            found.contains(&"compatible_with.acme.collection.tags.items_type"),
            "{issues:?}"
        );
        assert!(
            found.contains(&"compatible_with.acme.collection.workflow_stage.enum_values"),
            "{issues:?}"
        );
        accepted(
            json!({"id": "acme.open_workflow", "version": 1, "compatible_with": ["acme.workflow"],
                   "fields": {"workflow_stage": {"type": "enum", "enum_values": ["open"], "required": true}}}),
            &held,
        );
    }

    #[test]
    fn a_claim_against_an_unregistered_target_is_refused() {
        let issues = refused(
            json!({"id": "acme.orphan_claim", "version": 1, "compatible_with": ["nope.nothing"],
                   "fields": {"body": {"type": "string"}}}),
            &registry_with(&[]),
        );
        assert!(!violations(&issues).is_empty(), "{issues:?}");
    }

    #[test]
    fn the_targets_optional_fields_are_held_to_the_claim_but_may_be_absent_or_narrowed() {
        let held = registry_with(&[]);
        let numeric = refused(
            json!({"id": "acme.numeric_priority_task", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"title": {"type": "string", "required": true}, "priority": {"type": "integer"}}}),
            &held,
        );
        assert!(
            violations(&numeric).contains(&"compatible_with.core.task.priority.type"),
            "{numeric:?}"
        );
        let values = refused(
            json!({"id": "acme.extra_precision_task", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"title": {"type": "string", "required": true},
                              "precision": {"type": "enum", "enum_values": ["day", "century"]}}}),
            &held,
        );
        assert!(
            violations(&values).contains(&"compatible_with.core.task.precision.enum_values"),
            "{values:?}"
        );
        accepted(
            json!({"id": "acme.bare_task", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"title": {"type": "string", "required": true}}}),
            &held,
        );
        accepted(
            json!({"id": "acme.placed_task", "version": 1, "compatible_with": ["core.task"],
                   "fields": {"title": {"type": "string", "required": true},
                              "place": {"type": "enum", "enum_values": ["home", "office"]}}}),
            &held,
        );
    }

    #[test]
    fn a_claim_is_refused_where_the_type_widens_the_targets_required_enum_to_a_string() {
        let held = registry_with(&[json!({"id": "acme.staged", "version": 1, "fields": {
            "stage": {"type": "enum", "enum_values": ["open", "closed"], "required": true}}})]);
        let issues = refused(
            json!({"id": "acme.freeform_staged", "version": 1, "compatible_with": ["acme.staged"],
                   "fields": {"stage": {"type": "string", "required": true}}}),
            &held,
        );
        assert!(
            violations(&issues).contains(&"compatible_with.acme.staged.stage.type"),
            "{issues:?}"
        );
    }

    #[test]
    fn an_annotation_that_adds_no_values_is_free_and_one_that_contradicts_the_targets_is_refused() {
        let held = registry_with(&[]);
        accepted(
            json!({"id": "acme.plain_language_note", "version": 1, "compatible_with": ["core.note"],
                   "fields": {"body": {"type": "string", "required": true}, "language": {"type": "string"}}}),
            &held,
        );
        let issues = refused(
            json!({"id": "acme.miscoded_note", "version": 1, "compatible_with": ["core.note"],
                   "fields": {"body": {"type": "string", "required": true},
                              "language": {"type": "string", "format": "iso3166"}}}),
            &held,
        );
        assert!(
            violations(&issues).contains(&"compatible_with.core.note.language.format"),
            "{issues:?}"
        );
    }

    #[test]
    fn a_claim_takes_kinds_whose_values_are_a_subset_of_the_targets_and_refuses_the_widening() {
        let held = registry_with(&[
            json!({"id": "acme.loose", "version": 1, "fields": {
                "href": {"type": "string"}, "contact": {"type": "string"}, "seen_at": {"type": "string"},
                "born_on": {"type": "string"}, "score": {"type": "number"}}}),
            json!({"id": "acme.tight_target", "version": 1, "fields": {
                "href": {"type": "url"}, "score": {"type": "integer"}}}),
        ]);
        accepted(
            json!({"id": "acme.tight", "version": 1, "compatible_with": ["acme.loose"], "fields": {
                "href": {"type": "url"}, "contact": {"type": "email"}, "seen_at": {"type": "datetime"},
                "born_on": {"type": "date"}, "score": {"type": "integer"}}}),
            &held,
        );
        let issues = refused(
            json!({"id": "acme.loose_candidate", "version": 1, "compatible_with": ["acme.tight_target"],
                   "fields": {"href": {"type": "string"}, "score": {"type": "number"}}}),
            &held,
        );
        for field in ["href", "score"] {
            assert!(
                violations(&issues)
                    .contains(&format!("compatible_with.acme.tight_target.{field}.type").as_str()),
                "{field}: {issues:?}"
            );
        }
    }
}

mod explanations {
    use super::*;

    fn classes() -> Vec<(&'static str, Value, &'static str)> {
        vec![
            ("not an object", json!("core.note"), "_root"),
            (
                "missing id",
                json!({"fields": {"title": {"type": "string"}}}),
                "id",
            ),
            (
                "unknown field type",
                json!({"id": "acme.a", "fields": {"title": {"type": "strong"}}}),
                "fields.title.type",
            ),
            (
                "enum without values",
                json!({"id": "acme.b", "fields": {"stage": {"type": "enum"}}}),
                "fields.stage.enum_values",
            ),
            (
                "enum_values on a string field",
                json!({"id": "acme.b2", "fields": {"stage": {"type": "string", "enum_values": ["a"]}}}),
                "fields.stage.enum_values",
            ),
            (
                "array without items_type",
                json!({"id": "acme.c", "fields": {"tags": {"type": "array"}}}),
                "fields.tags.items_type",
            ),
            (
                "unknown format",
                json!({"id": "acme.d", "fields": {"code": {"type": "string", "format": "iso4217"}}}),
                "fields.code.format",
            ),
            (
                "annotation format on a non-string field",
                json!({"id": "acme.e", "fields": {"count": {"type": "integer", "format": "bcp47"}}}),
                "fields.count.format",
            ),
            (
                "type-naming format on a field of another type",
                json!({"id": "acme.e2", "fields": {"count": {"type": "integer", "format": "url"}}}),
                "fields.count.format",
            ),
            (
                "max_length on a non-string field",
                json!({"id": "acme.f", "fields": {"count": {"type": "integer", "max_length": 10}}}),
                "fields.count.max_length",
            ),
            (
                "max_length on a currency field",
                json!({"id": "acme.f2", "fields": {"code": {"type": "string", "format": "currency", "max_length": 2}}}),
                "fields.code.max_length",
            ),
            (
                "max_length on a currency member of a list entry",
                json!({"id": "acme.f3", "fields": {"prices": {"type": "array", "items_type": "object",
                    "items_fields": {"code": {"type": "string", "format": "currency", "max_length": 2}}}}}),
                "fields.prices.items_fields.code.max_length",
            ),
            (
                "max_items on a non-array field",
                json!({"id": "acme.g", "fields": {"title": {"type": "string", "max_items": 3}}}),
                "fields.title.max_items",
            ),
            (
                "non-positive cap",
                json!({"id": "acme.h", "fields": {"title": {"type": "string", "max_length": 0}}}),
                "fields.title.max_length",
            ),
            (
                "non-boolean searchable",
                json!({"id": "acme.i", "fields": {"title": {"type": "string", "searchable": "no"}}}),
                "fields.title.searchable",
            ),
            (
                "property shadows a first-class item field",
                json!({"id": "acme.j", "fields": {"occurred_at": {"type": "datetime"}}}),
                "fields.occurred_at",
            ),
            (
                "per-type lifecycle declaration",
                json!({"id": "acme.k", "fields": {"title": {"type": "string"}}, "states": ["open", "closed"]}),
                "states",
            ),
            (
                "display hint pointing at a missing field",
                json!({"id": "acme.l", "fields": {"title": {"type": "string"}}, "display_hints": {"body_field": "body"}}),
                "display_hints.body_field",
            ),
            (
                "unknown merge strategy",
                json!({"id": "acme.m", "fields": {"body": {"type": "string"}}, "merge_policy": {"fields": {"body": "shout_loudest"}}}),
                "merge_policy.fields.body",
            ),
            (
                "merge policy naming a missing field",
                json!({"id": "acme.n", "fields": {"body": {"type": "string"}}, "merge_policy": {"fields": {"notes": "last_writer_wins"}}}),
                "merge_policy.fields.notes",
            ),
            (
                "version policy with a non-integer",
                json!({"id": "acme.o", "fields": {"title": {"type": "string"}}, "version_policy": {"max_versions": 1.5}}),
                "version_policy.max_versions",
            ),
            (
                "version below 0",
                json!({"id": "acme.v", "version": -1, "fields": {"title": {"type": "string"}}}),
                "version",
            ),
            (
                "required naming a field that does not exist",
                json!({"id": "acme.p", "fields": {"title": {"type": "string"}}, "required": ["subtitle"]}),
                "required",
            ),
            (
                "inheritance reshaping an ancestor field",
                json!({"id": "acme.q", "parent": "core.note", "fields": {"body": {"type": "integer"}}}),
                "fields.body.type",
            ),
            (
                "compatible_with target missing a required field",
                json!({"id": "acme.r", "compatible_with": ["core.task"], "fields": {"headline": {"type": "string"}}}),
                "compatible_with.core.task.title",
            ),
            (
                "compatible_with naming an unregistered target",
                json!({"id": "acme.s", "compatible_with": ["nope.nothing"], "fields": {"title": {"type": "string"}}}),
                "compatible_with.nope.nothing",
            ),
            (
                "thumbnail named for a field search always indexes",
                json!({"id": "acme.t", "fields": {"title": {"type": "thumbnail"}}}),
                "fields.title",
            ),
            (
                "a second thumbnail",
                json!({"id": "acme.u", "fields": {"thumbnail": {"type": "thumbnail"}, "cover": {"type": "string", "format": "thumbnail"}}}),
                "fields.cover",
            ),
            (
                "link_field that is not a string",
                json!({"id": "acme.v", "fields": {"vendor_id": {"type": "string"}}, "link_field": ["vendor_id"]}),
                "link_field",
            ),
            (
                "link_field naming a missing field",
                json!({"id": "acme.w", "fields": {"vendor_id": {"type": "string"}}, "link_field": "remote_id"}),
                "link_field",
            ),
            (
                "link_field naming a field that is not a string",
                json!({"id": "acme.x", "fields": {"vendor_id": {"type": "integer"}}, "link_field": "vendor_id"}),
                "link_field",
            ),
            (
                "link_field naming a field whose name holds a quote",
                json!({"id": "acme.y", "fields": {"vendor\"id": {"type": "string"}}, "link_field": "vendor\"id"}),
                "link_field",
            ),
        ]
    }

    #[test]
    fn every_refusal_names_where_it_happened_what_was_required_what_arrived_and_what_to_do() {
        let held = registry_with(&[]);
        assert_eq!(classes().len(), 32);
        for (name, input, at) in classes() {
            let issues = refused(input, &held);
            let found = issues
                .iter()
                .find(|issue| issue.field == at)
                .unwrap_or_else(|| {
                    panic!("{name}: no issue at \"{at}\"; got {:?}", fields_of(&issues))
                });
            assert!(!found.expected.is_empty(), "{name}: expected is empty");
            assert!(!found.actual.is_empty(), "{name}: actual is empty");
            assert!(!found.hint.is_empty(), "{name}: hint is empty");
            assert!(found.hint.trim().ends_with('.'), "{name}: {}", found.hint);
            let message = found.message();
            for part in [&found.expected, &found.actual, &found.hint] {
                assert!(message.contains(part.as_str()), "{name}: {message}");
            }
            for issue in &issues {
                assert!(
                    !issue.field.is_empty()
                        && !issue.expected.is_empty()
                        && !issue.actual.is_empty()
                        && !issue.hint.is_empty(),
                    "{name}: {issue:?}"
                );
            }
        }
    }

    #[test]
    fn a_shadowed_first_class_field_an_inheritance_violation_and_a_compatibility_violation_carry_their_codes()
     {
        let held = registry_with(&[]);
        let shadow = refused(
            json!({"id": "acme.shadow", "fields": {"source_id": {"type": "string"}}}),
            &held,
        );
        assert!(
            shadow
                .iter()
                .any(|i| i.code == Some("property_shadows_field")),
            "{shadow:?}"
        );
        let reshape = refused(
            json!({"id": "acme.reshape", "parent": "core.note", "fields": {"body": {"type": "integer"}}}),
            &held,
        );
        assert!(
            reshape
                .iter()
                .any(|i| i.code == Some("inheritance_violation")),
            "{reshape:?}"
        );
        let claim = refused(
            json!({"id": "acme.claim", "compatible_with": ["core.task"], "fields": {"headline": {"type": "string"}}}),
            &held,
        );
        assert!(
            claim
                .iter()
                .any(|i| i.code == Some("compatible_with_violation")),
            "{claim:?}"
        );
    }
}

mod unread {
    use super::*;

    fn recipe() -> Value {
        json!({"id": "user.recipe", "version": 1,
               "fields": {"title": {"type": "string"}, "serves": {"type": "integer"}},
               "required": ["title"]})
    }

    fn base() -> Registry {
        registry_with(&[
            json!({"id": "user.base", "version": 1, "fields": {"title": {"type": "string"}}}),
        ])
    }

    fn paths(issues: &[Issue]) -> Vec<String> {
        issues.iter().map(|issue| issue.field.clone()).collect()
    }

    #[test]
    fn a_type_carrying_only_keys_the_rules_read_is_taken() {
        assert!(unread_keys(&row(recipe())).is_empty());
        accepted(recipe(), &base());
    }

    #[test]
    fn a_top_level_key_nothing_reads_is_named_and_refused() {
        let mut input = recipe();
        input["_deferred"] = json!(true);
        assert_eq!(paths(&unread_keys(&row(input.clone()))), ["_deferred"]);
        assert_eq!(fields_of(&refused(input, &base())), ["_deferred"]);
    }

    #[test]
    fn a_key_inside_a_field_is_named_by_its_path_whatever_the_fields_type() {
        let mut input = recipe();
        input["fields"] = json!({
            "title": {"type": "string", "maxLength": 10},
            "serves": {"type": "integer", "exclusiveMinimum": 1, "exclusiveMaximum": 12}});
        assert_eq!(
            fields_of(&refused(input, &base())),
            [
                "fields.title.maxLength",
                "fields.serves.exclusiveMinimum",
                "fields.serves.exclusiveMaximum"
            ]
        );
    }

    #[test]
    fn every_key_a_field_definition_can_carry_registers_on_a_field_that_can_carry_it() {
        accepted(
            json!({"id": "user.everything", "version": 1, "fields": {
                "name": {"type": "string", "label": "Name", "description": "d", "required": true,
                         "searchable": false, "max_length": 10},
                "kind": {"type": "enum", "enum_values": ["a", "b"]},
                "stage": {"type": "status", "status_values": [{"value": "todo", "group": "not_started"}]},
                "tags": {"type": "array", "items_type": "string", "max_items": 3},
                "lang": {"type": "string", "format": "bcp47"},
                "serves": {"type": "integer", "minimum": 1, "maximum": 12},
                "authors": {"type": "array", "items_type": "object",
                            "items_fields": {"name": {"type": "string", "required": true}}}}}),
            &base(),
        );
    }

    #[test]
    fn a_key_inside_a_hint_or_a_policy_is_named_by_its_path() {
        let mut input = recipe();
        input["display_hints"] = json!({"title_field": "title", "subtitle_field": "title"});
        input["version_policy"] = json!({"max_versions": 5, "keep_forever": true});
        input["merge_policy"] = json!({"default": "last_writer_wins", "fallback": "x"});
        input["retention_policy"] = json!({"feed_days": 30, "library_days": 5});
        assert_eq!(
            fields_of(&refused(input, &base())),
            [
                "display_hints.subtitle_field",
                "version_policy.keep_forever",
                "merge_policy.fallback",
                "retention_policy.library_days"
            ]
        );
    }

    #[test]
    fn a_misspelling_is_pointed_at_the_key_it_is_likely_to_mean() {
        let mut input = recipe();
        input["fields"] = json!({"title": {"type": "string", "maxLength": 10}});
        let issues = unread_keys(&row(input.clone()));
        assert!(
            issues[0].hint.contains("\"max_length\""),
            "{}",
            issues[0].hint
        );
        input["fields"] = json!({"title": {"type": "string", "exclusiveMinimum": 1}});
        let issues = unread_keys(&row(input));
        assert!(!issues[0].hint.contains("Write"), "{}", issues[0].hint);
    }

    #[test]
    fn a_field_that_is_not_an_object_is_left_to_the_registration_rules() {
        let mut input = recipe();
        input["fields"] = json!({"title": "string"});
        assert!(unread_keys(&row(input.clone())).is_empty());
        assert_eq!(fields_of(&refused(input, &base())), ["fields.title"]);
    }

    #[test]
    fn a_key_the_rules_refuse_themselves_is_left_to_them_and_reported_once() {
        let mut input = recipe();
        input["states"] = json!(["draft"]);
        assert_eq!(fields_of(&refused(input, &base())), ["states"]);
        for key in ["states", "default_state", "transitions"] {
            let mut input = recipe();
            input[key] = json!({});
            assert!(unread_keys(&row(input)).is_empty(), "{key}");
        }
    }

    #[test]
    fn an_edge_type_carrying_only_keys_the_rules_read_is_taken() {
        let input = json!({"id": "cites", "label": "Test label", "cardinality": "many-to-many"});
        assert!(unread_edge_keys(&row(input.clone())).is_empty());
        assert!(edge(input).is_ok());
    }

    #[test]
    fn an_edge_types_top_level_key_and_property_key_nothing_reads_are_named() {
        let bad = json!({"id": "cites", "label": "Test label", "cardinality": "many-to-many", "fields": {},
                         "property_schema": {"rank": {"type": "number", "minimum": 0}}});
        assert_eq!(
            paths(&unread_edge_keys(&row(bad.clone()))),
            ["fields", "property_schema.rank.minimum"]
        );
    }

    #[test]
    fn no_shipped_definition_carries_a_key_nothing_reads() {
        let (types, edges) = shipped_sources(&definitions()).unwrap_or_else(|e| panic!("{e}"));
        assert!(!types.is_empty() && !edges.is_empty());
        for (file, definition) in &types {
            assert!(unread_keys(definition).is_empty(), "{file}");
        }
        for (file, definition) in &edges {
            assert!(unread_edge_keys(definition).is_empty(), "{file}");
        }
    }
}

mod edges {
    use super::*;

    fn is_kebab(name: &str) -> bool {
        name.starts_with(|c: char| c.is_ascii_lowercase())
            && name.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
    }

    fn minimal(extra: Value) -> Value {
        let mut base = json!({"id": "cites", "label": "Test label", "cardinality": "many-to-many"});
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        base
    }

    #[test]
    fn a_minimal_edge_type_is_taken_with_its_defaults() {
        let stored = edge(minimal(json!({}))).unwrap();
        assert_eq!(stored["id"], "cites");
        assert_eq!(stored["label"], "Test label");
        assert_eq!(stored["cardinality"], "many-to-many");
        assert_eq!(stored["from_type_constraints"], json!(["*"]));
        assert_eq!(stored["to_type_constraints"], json!(["*"]));
        assert_eq!(stored["cascade_on_delete"], "orphan");
        assert_eq!(stored["property_schema"], json!({}));
        assert_eq!(stored["written_from"], "from");
    }

    #[test]
    fn edge_properties_normalize_through_the_item_field_model() {
        let stored = edge(minimal(json!({"id": "linked-from", "property_schema": {
            "source_url": {"type": "string", "format": "url"},
            "position": {"type": "number", "description": "Ordering."}}})))
        .unwrap();
        assert_eq!(
            stored["property_schema"]["source_url"],
            json!({"type": "url"})
        );
        assert_eq!(
            stored["property_schema"]["position"],
            json!({"type": "number", "description": "Ordering."})
        );
    }

    #[test]
    fn a_reverse_label_is_optional_and_never_empty() {
        let one_end = edge(minimal(json!({"label": "Cites"}))).unwrap();
        assert!(one_end.get("reverse_label").is_none());
        let two_ends = edge(minimal(
            json!({"label": "Cites", "reverse_label": "Cited by"}),
        ))
        .unwrap();
        assert_eq!(two_ends["reverse_label"], "Cited by");
        assert!(edge(minimal(json!({"label": "Cites", "reverse_label": ""}))).is_err());
    }

    #[test]
    fn an_edge_type_that_lacks_its_id_or_cardinality_is_refused_naming_it() {
        assert!(request_shape(&Obj::new()).is_err());
        assert_eq!(
            edge_field(&request_shape(&row(json!({"cardinality": "many-to-many"}))).unwrap_err()),
            Some("id".into())
        );
        assert_eq!(
            edge_field(&request_shape(&row(json!({"id": "cites"}))).unwrap_err()),
            Some("cardinality".into())
        );
    }

    #[test]
    fn an_unknown_cardinality_cascade_or_malformed_constraint_is_refused() {
        for cardinality in [json!("one-to-few"), json!(4)] {
            assert!(edge(minimal(json!({"cardinality": cardinality}))).is_err());
        }
        assert!(edge(minimal(json!({"cascade_on_delete": "detach"}))).is_err());
        for bad in [json!([42]), json!("core.note"), json!(["*", ""])] {
            assert!(
                edge(minimal(json!({"to_type_constraints": bad.clone()}))).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_property_of_an_unknown_field_type_is_refused_naming_the_field() {
        let refusal = edge(minimal(
            json!({"property_schema": {"weight": {"type": "float"}}}),
        ))
        .unwrap_err();
        assert_eq!(
            edge_field(&refusal),
            Some("property_schema.weight.type".into())
        );
    }

    #[test]
    fn a_role_is_taken_on_either_side_beside_a_type_and_refused_when_nobody_defines_it() {
        for side in ["from_type_constraints", "to_type_constraints"] {
            let stored = edge(minimal(
                json!({"id": "shelved-in", side: ["role:container"]}),
            ))
            .unwrap();
            assert_eq!(stored[side], json!(["role:container"]));
            assert!(
                edge(minimal(
                    json!({"id": "shelved-in", side: ["role:warehouse"]})
                ))
                .is_err(),
                "{side}"
            );
        }
        assert!(
            edge(minimal(
                json!({"id": "shelved-in", "to_type_constraints": ["core.note", "role:container"]})
            ))
            .is_ok()
        );
    }

    #[test]
    fn a_reverse_name_is_kept_and_refused_when_it_is_not_an_identifier_or_is_the_id() {
        let kept = edge(minimal(
            json!({"id": "mentors", "cardinality": "one-to-many", "reverse_name": "mentored-by"}),
        ))
        .unwrap();
        assert_eq!(kept["reverse_name"], "mentored-by");
        for bad in [json!("Mentored By"), json!(""), json!(7)] {
            let refusal = edge(minimal(
                json!({"id": "mentors", "cardinality": "one-to-many", "reverse_name": bad.clone()}),
            ));
            assert!(refusal.is_err(), "{bad}");
        }
    }

    #[test]
    fn an_edge_is_written_from_its_from_end_unless_told_and_the_to_end_needs_a_reverse_name() {
        assert_eq!(edge(minimal(json!({}))).unwrap()["written_from"], "from");
        let to = edge(minimal(
            json!({"id": "mentors", "cardinality": "one-to-many",
                                     "reverse_name": "mentored-by", "written_from": "to"}),
        ))
        .unwrap();
        assert_eq!(to["written_from"], "to");
        let none = edge(minimal(json!({"id": "placed-in", "written_from": "none"}))).unwrap();
        assert_eq!(none["written_from"], "none");
        for bad in ["middle", "source", "target"] {
            assert!(
                edge(minimal(
                    json!({"id": "mentors", "cardinality": "one-to-many", "written_from": bad})
                ))
                .is_err(),
                "{bad}"
            );
        }
        assert!(
            edge(minimal(
                json!({"id": "mentors", "cardinality": "one-to-many", "written_from": "to"})
            ))
            .is_err(),
            "to with no reverse name"
        );
    }

    #[test]
    fn every_failure_of_an_edge_type_property_set_is_collected_not_only_the_first() {
        let refusal = edge(minimal(json!({"property_schema": {
            "a": {"type": "float"}, "b": {"type": "double"}}})))
        .unwrap_err();
        match refusal {
            EdgeIssues::Schema(issues) => assert_eq!(issues.len(), 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_shipped_edge_types_are_kebab_words_and_no_name_is_held_twice() {
        let (_, edges) = shipped_sources(&definitions()).unwrap();
        let registered = register_edges(&edges).unwrap_or_else(|e| panic!("{}", e.join("\n")));
        let mut names: Vec<String> = Vec::new();
        for stored in &registered {
            let id = stored["id"].as_str().unwrap();
            let kebab = is_kebab(id);
            assert!(kebab, "{id}");
            names.push(id.to_string());
            if let Some(reverse) = stored.get("reverse_name").and_then(Value::as_str) {
                assert!(is_kebab(reverse), "{reverse}");
                names.push(reverse.to_string());
            }
        }
        let distinct: BTreeSet<&String> = names.iter().collect();
        assert_eq!(distinct.len(), names.len(), "{names:?}");
        assert!(
            names.len() > registered.len(),
            "no shipped edge type declares a reverse name"
        );
    }
}

mod folder {
    use super::*;

    #[test]
    fn a_shipped_edge_file_is_refused_for_an_id_that_is_not_kebab_or_a_constraint_list_that_is_empty()
     {
        let file = |id: &str, extra: Value| {
            let mut definition = json!({"id": id, "label": "L", "reverse_label": "R", "cardinality": "many-to-many"});
            if let (Some(definition), Some(extra)) = (definition.as_object_mut(), extra.as_object())
            {
                definition.extend(extra.clone());
            }
            (format!("{id}.json"), row(definition))
        };
        assert!(register_edges(&[file("in-thread", json!({}))]).is_ok());
        for id in [
            "in_thread",
            "in.thread",
            "-thread",
            "thread-",
            "in--thread",
            "In-thread",
        ] {
            assert!(register_edges(&[file(id, json!({}))]).is_err(), "{id}");
        }
        for side in ["from_type_constraints", "to_type_constraints"] {
            let refused = register_edges(&[file("in-thread", json!({side: []}))]).unwrap_err();
            assert!(refused[0].contains(side), "{refused:?}");
        }
    }

    #[test]
    fn a_folder_of_definitions_is_refused_for_a_repeated_id_a_missing_parent_or_a_loop() {
        let one = |id: &str, extra: Value| -> (String, Obj) {
            let mut definition = json!({"id": id, "fields": {"title": {"type": "string"}}});
            if let (Some(definition), Some(extra)) = (definition.as_object_mut(), extra.as_object())
            {
                definition.extend(extra.clone());
            }
            (format!("{id}.json"), row(definition))
        };
        let twice = register_types(&[one("core.a", json!({})), one("core.a", json!({}))]);
        assert!(twice.is_err(), "a repeated id");
        let orphan = register_types(&[one("core.a.b", json!({"parent": "core.a"}))]);
        assert!(orphan.is_err(), "a parent that is not in the folder");
        let looped = register_types(&[
            one("core.a", json!({"parent": "core.b"})),
            one("core.b", json!({"parent": "core.a"})),
        ]);
        assert!(looped.is_err(), "a loop");
        let ordered = register_types(&[
            one("core.a.b", json!({"parent": "core.a"})),
            one("core.a", json!({})),
        ]);
        assert!(ordered.is_ok(), "a child listed before its parent");
    }

    #[test]
    fn a_shipped_edge_file_is_refused_for_no_label_no_reverse_label_or_a_reverse_name_that_is_not_a_kebab_word()
     {
        let file = |extra: Value| {
            let mut definition = json!({"id": "reviews", "label": "Reviews", "reverse_label": "R", "cardinality": "many-to-many"});
            if let (Some(definition), Some(extra)) = (definition.as_object_mut(), extra.as_object())
            {
                definition.extend(extra.clone());
            }
            ("reviews.json".to_string(), row(definition))
        };
        assert!(register_edges(&[file(json!({"reverse_name": "reviewed-by"}))]).is_ok());
        for bad in ["reviewed_by", "Reviewed-by", "reviewed--by", "-reviewed"] {
            let refused = register_edges(&[file(json!({"reverse_name": bad}))]).unwrap_err();
            assert!(
                refused.iter().any(|line| line.contains("reverse_name")),
                "{bad}: {refused:?}"
            );
        }
        let mut without = file(json!({}));
        without.1.remove("label");
        let refused = register_edges(&[without]).unwrap_err();
        assert!(
            refused.iter().any(|line| line.contains("label")),
            "{refused:?}"
        );
        let refused = register_edges(&[file(json!({"label": ""}))]).unwrap_err();
        assert!(
            refused.iter().any(|line| line.contains("label")),
            "{refused:?}"
        );
        let mut without = file(json!({}));
        without.1.remove("reverse_label");
        for edge in [
            without,
            file(json!({"reverse_label": ""})),
            file(json!({"reverse_label": "  "})),
        ] {
            let refused = register_edges(&[edge]).unwrap_err();
            assert!(
                refused.iter().any(|line| line.contains("reverse_label")),
                "{refused:?}"
            );
        }
    }

    #[test]
    fn a_wrongly_named_edge_file_has_every_fault_listed_with_its_file() {
        let both = |id: &str| {
            (
                format!("{id}.json"),
                row(
                    json!({"id": id, "label": "L", "reverse_label": "R", "cardinality": "many-to-many"}),
                ),
            )
        };
        let bad = register_edges(&[
            (
                "wrong.json".to_string(),
                row(json!({"id": "other", "label": "L", "cardinality": "sideways", "extra": 1})),
            ),
            both("fine"),
        ])
        .unwrap_err();
        assert!(bad.len() >= 3, "{bad:?}");
        assert!(
            bad.iter().all(|line| line.starts_with("wrong.json")),
            "{bad:?}"
        );
    }
}
