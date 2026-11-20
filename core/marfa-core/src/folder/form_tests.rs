//! A directory that never had a file writes it in the form its placement
//! holds, so two directories of one folder hold the same bytes.

use serde_json::{Map, Value, json};

use super::tests::{folder_with, scanned_folder};
use super::*;
use crate::Edge;
use crate::store::{self, meta_set};

const TOP: &str = "---\ntitle: Top\n---\nThe top project.\n";

const DECISION: &str = "---\ntitle: A decision\noccurred_at: 2026-10-11\nstarts_at:\nsaid: 'Said once'\nquoted: \"Said twice\"\ntags: [one, two]\nnotes: |\n  First line.\n  Second line.\n---\nWhy it was decided.\n";

const SESSION: &str = "---\ntitle: A session\ndescription: \"A session with empty times.\"\nstarts_at:\nends_at:\ntags:\n  - a\n  - b\ntier: library\n---\n## Brief\n\nDo the thing.\n";

/// A first directory that read `files` and had what it sent taken, and a
/// second directory of the same folder.
struct Two {
    first: tests::ScannedDir,
    a: Folder,
    /// The edge creates the first directory sent.
    creates: Vec<crate::model::QueuedWrite>,
    second: tempfile::TempDir,
    b: Folder,
}

fn two(files: &[(&str, &str)]) -> Two {
    let (first, a) = scanned_folder();
    for (name, text) in files {
        std::fs::write(first.path().join(name), text).unwrap();
    }
    a.scan().unwrap();
    a.scan().unwrap();
    let creates =
        store::read_writes(&a.core.conn().unwrap(), "WHERE kind = 'create_edge'", []).unwrap();
    for (name, _) in files {
        tests::landed(&a, name);
    }
    a.core
        .conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
    a.pull().unwrap();
    let (second, b) = folder_with(&a.folder, json!({ "query": {} }), None);
    Two {
        first,
        a,
        creates,
        second,
        b,
    }
}

impl Two {
    /// Brings every item the first directory holds and its edges into the
    /// second copy, with `edge` changing each placement, and pulls.
    fn pulled(&self, edge: impl Fn(&mut Map<String, Value>)) -> PullReport {
        let bound = state::every_bound(&self.a.core.conn().unwrap()).unwrap();
        let mut items = Vec::new();
        let mut edges = Vec::new();
        for bound in &bound {
            items.push(self.a.core.get(&bound.item_id).unwrap().unwrap());
            edges.extend(self.a.core.edges_from(&bound.item_id).unwrap());
        }
        let conn = self.b.core.conn().unwrap();
        meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        for item in items {
            let mut wire = item.as_wire();
            wire.version = 1;
            crate::reach::set_listed(&conn, &item.id, true).unwrap();
            store::put_server_item(&conn, &wire, Some(&item.tags), &catalog).unwrap();
        }
        for held in edges {
            let mut wire = held.as_wire();
            wire.version = 1;
            if wire.edge_type == placement::PLACEMENT_EDGE {
                edge(&mut wire.properties);
            }
            store::put_server_edge(&conn, &wire).unwrap();
        }
        drop(conn);
        self.b.pull().unwrap()
    }

    /// The item whose file sits at `name` in `folder`.
    fn item_at(folder: &Folder, name: &str) -> String {
        state::bound_at(&folder.core.conn().unwrap(), name)
            .unwrap()
            .unwrap()
            .item_id
    }

    fn first_file(&self, name: &str) -> String {
        std::fs::read_to_string(self.first.path().join(name)).unwrap()
    }

    fn second_file(&self, name: &str) -> String {
        std::fs::read_to_string(self.second.path().join(name)).unwrap()
    }

    fn placement(&self, name: &str) -> Edge {
        self.a
            .placement(&Two::item_at(&self.a, name))
            .unwrap()
            .unwrap()
    }
}

/// The file's text without its item's id, which differs between two runs.
fn unidentified(text: &str) -> String {
    text.lines()
        .filter(|line| !line.starts_with("marfa_id:"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn no_form(properties: &mut Map<String, Value>) {
    properties.remove(form::FORM_PROPERTY);
}

#[test]
fn a_second_directory_writes_each_file_as_the_first_wrote_it() {
    let files = [
        ("Top.md", TOP),
        ("A decision.md", DECISION),
        ("A session.md", SESSION),
    ];
    // The witness: without a form the second directory writes its own way.
    let without = two(&files);
    without.pulled(no_form);
    assert_ne!(
        without.second_file("A decision.md"),
        without.first_file("A decision.md")
    );
    assert_ne!(
        without.second_file("A session.md"),
        without.first_file("A session.md")
    );

    let with = two(&files);
    with.pulled(|_| {});
    for (name, text) in files {
        let first = with.first_file(name);
        assert!(
            first.starts_with(text.split("\n---\n").next().unwrap()),
            "{name} changed where it was made: {first}"
        );
        assert_eq!(with.second_file(name), first, "{name}");
    }
}

#[test]
fn a_created_files_placement_carries_its_form_and_no_value() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    let edge = pair.placement("A decision.md");
    let held = edge.properties.get(form::FORM_PROPERTY).unwrap();
    let keys: Vec<&str> = held["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "title",
            "occurred_at",
            "starts_at",
            "said",
            "quoted",
            "tags",
            "notes"
        ]
    );
    let sent = held.to_string();
    for value in ["A decision", "2026-10-11", "Said", "one", "First", "Why"] {
        assert!(!sent.contains(value), "the form holds {value}: {sent}");
    }
    assert!(
        pair.creates
            .iter()
            .any(|write| write.body.to_string().contains("\"form\"")
                && write.body.to_string().contains("A decision.md")),
        "{:?}",
        pair.creates
    );
}

#[test]
fn a_day_changed_elsewhere_to_a_time_is_written_in_full() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    let item = Two::item_at(&pair.a, "A decision.md");
    let conn = pair.a.core.conn().unwrap();
    conn.execute(
        "UPDATE items SET occurred_at = '2026-10-11T09:30:00.000Z' WHERE id = ?1",
        [&item],
    )
    .unwrap();
    drop(conn);
    pair.pulled(|_| {});
    let written = pair.second_file("A decision.md");
    assert!(
        written.starts_with(
            "---\ntitle: A decision\noccurred_at: \"2026-10-11T09:30:00.000Z\"\nstarts_at:\n"
        ),
        "{written}"
    );
}

#[test]
fn a_placement_with_no_form_writes_the_file_as_before() {
    let files = [("Top.md", TOP), ("A decision.md", DECISION)];
    let without = two(&files);
    without.pulled(no_form);
    let canonical = without.second_file("A decision.md");
    assert!(
        canonical.starts_with("---\ntype: core.note\ntier: library\ntags:\n  - one\n  - two\n")
            && canonical.contains("\nstarts_at: ~\n"),
        "{canonical}"
    );
}

#[test]
fn a_form_unreadable_as_one_writes_the_file_as_before() {
    let files = [("Top.md", TOP), ("A decision.md", DECISION)];
    let without = two(&files);
    without.pulled(no_form);
    let broken = two(&files);
    broken.pulled(|properties| {
        properties.insert(form::FORM_PROPERTY.into(), json!({ "keys": "none" }));
    });
    assert_eq!(
        unidentified(&broken.second_file("A decision.md")),
        unidentified(&without.second_file("A decision.md"))
    );
}

#[test]
fn a_form_changed_alone_rewrites_no_file() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    pair.pulled(|_| {});
    pair.b.pull().unwrap();
    let before = pair.second_file("A decision.md");
    let item = Two::item_at(&pair.b, "A decision.md");
    let mut edge = pair.b.placement(&item).unwrap().unwrap().as_wire();
    edge.version += 1;
    edge.properties.insert(
        form::FORM_PROPERTY.into(),
        json!({ "keys": [{ "key": "tags", "style": "block", "items": "plain", "indent": 2 }] }),
    );
    store::put_server_edge(&pair.b.core.conn().unwrap(), &edge).unwrap();
    let pulled = pair.b.pull().unwrap();
    assert_eq!((pulled.written, pulled.rewritten), (0, 0), "{pulled:?}");
    assert_eq!(pair.second_file("A decision.md"), before);

    // The witness: a change to the item does rewrite the file, as a rewrite
    // of a file it had writes it.
    let mut changed = pair.b.core.get(&item).unwrap().unwrap();
    changed
        .properties
        .insert("said".into(), json!("Said again"));
    changed.version += 1;
    let conn = pair.b.core.conn().unwrap();
    let catalog = crate::catalog::load(&conn).unwrap();
    store::put_server_item(&conn, &changed.as_wire(), Some(&changed.tags), &catalog).unwrap();
    drop(conn);
    let pulled = pair.b.pull().unwrap();
    assert_eq!(pulled.rewritten, 1, "{pulled:?}");
    assert_eq!(
        pair.second_file("A decision.md"),
        before
            .replace("'Said once'", "Said again")
            .replace("marfa_version: 1", "marfa_version: 2")
    );
}

#[test]
fn a_file_changed_here_sends_its_new_form_and_one_unchanged_sends_none() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    let updates = |folder: &Folder| {
        store::read_writes(
            &folder.core.conn().unwrap(),
            "WHERE kind = 'update_edge'",
            [],
        )
        .unwrap()
        .len()
    };
    let before = updates(&pair.a);
    pair.a.scan().unwrap();
    assert_eq!(updates(&pair.a), before, "an unchanged file sent a form");

    let path = pair.first.path().join("A decision.md");
    std::fs::write(
        &path,
        DECISION.replace("tags: [one, two]", "tags:\n- one\n- two"),
    )
    .unwrap();
    pair.a.scan().unwrap();
    let edge = pair.placement("A decision.md");
    let tags = edge.properties[form::FORM_PROPERTY]["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["key"] == "tags")
        .unwrap()
        .clone();
    assert_eq!(tags["style"], "block", "{edge:?}");
    assert_eq!(
        edge.properties[placement::PATH_PROPERTY],
        json!("A decision.md")
    );
}

#[test]
fn a_placement_the_server_takes_no_form_on_carries_none() {
    let (dir, folder) = scanned_folder();
    {
        let mut catalog = marfa_rules::builtin::catalog().unwrap();
        let placement = catalog
            .edge_types
            .iter_mut()
            .find(|edge| edge["id"] == placement::PLACEMENT_EDGE)
            .unwrap();
        let schema = placement["property_schema"].as_object_mut().unwrap();
        // The witness: the shipped placement takes a form.
        assert!(schema.remove(form::FORM_PROPERTY).is_some());
        store::replace_catalog(&folder.core.conn().unwrap(), &catalog).unwrap();
    }
    std::fs::write(dir.path().join("A decision.md"), DECISION).unwrap();
    folder.scan().unwrap();
    folder.scan().unwrap();
    let edge = folder
        .placement(&Two::item_at(&folder, "A decision.md"))
        .unwrap()
        .unwrap();
    assert_eq!(edge.properties.get(form::FORM_PROPERTY), None);
    let writes =
        store::read_writes(&folder.core.conn().unwrap(), "WHERE kind LIKE '%edge'", []).unwrap();
    assert!(
        writes
            .iter()
            .all(|write| !write.body.to_string().contains("\"form\"")),
        "{writes:?}"
    );
}

#[test]
fn a_form_changed_by_an_edit_waits_for_the_server_to_take_that_edit() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    let path = pair.first.path().join("A decision.md");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        text.replacen(
            "title: A decision\n",
            "title: A decision\nadded_key: its value\n",
            1,
        ),
    )
    .unwrap();
    pair.a.scan().unwrap();
    let carrying = |kind: &str, text: &str| {
        let conn = pair.a.core.conn().unwrap();
        store::read_writes(&conn, "WHERE kind = ?1", [kind])
            .unwrap()
            .into_iter()
            .filter(|write| store::payload_of(&conn, &write.id).unwrap().contains(text))
            .collect::<Vec<_>>()
    };
    let edit = carrying("update_item", "its value");
    assert_eq!(edit.len(), 1, "the witness: the edit was queued");
    assert_eq!(carrying("update_edge", "added_key").len(), 0);
    pair.a.scan().unwrap();
    assert_eq!(carrying("update_edge", "added_key").len(), 0);

    // Once the server takes the edit, the next pass sends the form, though
    // the file is as that pass left it.
    store::record_verdict(
        &pair.a.core.conn().unwrap(),
        &edit[0].id,
        &store::Answered {
            verdict: crate::model::Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    pair.a.scan().unwrap();
    let form = carrying("update_edge", "added_key");
    assert_eq!(form.len(), 1, "{form:?}");
    let payload = store::payload_of(&pair.a.core.conn().unwrap(), &form[0].id).unwrap();
    assert!(!payload.contains("its value"), "{payload}");
    assert!(!payload.contains("\"path\""), "{payload}");
    pair.a.scan().unwrap();
    assert_eq!(carrying("update_edge", "added_key").len(), 1);
}

#[test]
fn a_file_written_with_no_form_fills_none_and_a_persons_file_fills_its_own() {
    let pair = two(&[("Top.md", TOP), ("A decision.md", DECISION)]);
    pair.pulled(no_form);
    let forms_sent = |folder: &Folder| {
        let conn = folder.core.conn().unwrap();
        store::read_writes(&conn, "WHERE kind = 'update_edge'", [])
            .unwrap()
            .into_iter()
            .filter(|write| {
                store::payload_of(&conn, &write.id)
                    .unwrap()
                    .contains("\"form\"")
            })
            .count()
    };
    pair.b.scan().unwrap();
    pair.b.scan().unwrap();
    assert_eq!(
        forms_sent(&pair.b),
        0,
        "{}",
        pair.second_file("A decision.md")
    );

    // The witness: the person's file, its placement holding no form, fills it.
    let mut edge = pair.placement("A decision.md").as_wire();
    edge.version += 1;
    no_form(&mut edge.properties);
    store::put_server_edge(&pair.a.core.conn().unwrap(), &edge).unwrap();
    let before = forms_sent(&pair.a);
    pair.a.scan().unwrap();
    assert_eq!(forms_sent(&pair.a), before + 1);
    pair.a.scan().unwrap();
    assert_eq!(forms_sent(&pair.a), before + 1);

    // A later run of the second directory, as the next push is, knows its
    // files need no form without rendering them.
    let Two { b, second, .. } = pair;
    drop(b);
    let again = Folder::open(second.path(), None).unwrap();
    tests::rendered();
    again.scan().unwrap();
    assert_eq!(tests::rendered(), 0);
    assert_eq!(forms_sent(&again), 0);
}

#[test]
fn a_form_read_from_a_placement_is_held_to_the_limits_one_is_sent_within() {
    let block = |indent: u64| json!({"keys": [{"key": "tags", "style": "block", "items": "plain", "indent": indent}]});
    // The witness: a form a device sends reads back.
    assert!(form::Form::read(&block(2)).is_some());
    assert!(
        form::Form::read(&block(4_000_000_000_000_000_000)).is_none(),
        "a form whose list sits further right than any file's was taken"
    );
    let many: Vec<Value> = (0..2_000)
        .map(|n| json!({"key": format!("key-{n}"), "style": "empty"}))
        .collect();
    assert!(
        form::Form::read(&json!({ "keys": many })).is_none(),
        "a form larger than a device sends was taken"
    );
}
