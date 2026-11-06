//! A refused edge create a folder has proved it no longer needs leaves its
//! queue as a drain begins, with nothing else moved: one whose edge the server
//! holds, and one a later create of the same edge carries.

use std::path::Path;

use serde_json::{Value, json};

use super::tests::{rendered, watched_notes};
use super::*;
use crate::catalog::End;
use crate::model::{QueuedWrite, Verdict, WriteKind};
use crate::store::{self, Answered};

const ONE_TO_ONE: &str = "supersedes";
const CONSTRAINT: &str = "edge_constraint_violation";

/// A folder of a source and a target, with the watch's server kept alive.
struct Fixture {
    dir: tests::ScannedDir,
    folder: Folder,
    source: String,
    target: String,
    _server: crate::scripted::Scripted,
}

fn fixture() -> Fixture {
    let (dir, folder, server, _passes) = watched_notes(&["a.md", "t.md"]);
    let source = item_of(&folder, "a.md");
    let target = item_of(&folder, "t.md");
    Fixture {
        dir,
        folder,
        source,
        target,
        _server: server,
    }
}

fn item_of(folder: &Folder, path: &str) -> String {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .unwrap()
        .item_id
}

/// Gives the file a line naming `target` and the words `body`, keeping the
/// frontmatter the folder wrote, and scans.
fn lined(dir: &Path, folder: &Folder, name: &str, target: &str, body: &str) {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path).unwrap();
    let rest = text
        .strip_prefix("---\n")
        .unwrap_or_else(|| panic!("{name} has no frontmatter: {text}"));
    let end = rest.find("\n---\n").unwrap();
    let frontmatter: String = rest[..=end]
        .split_inclusive('\n')
        .filter(|line| !line.starts_with("supersedes:"))
        .collect();
    std::fs::write(
        &path,
        format!("---\nsupersedes: \"[[{target}]]\"\n{frontmatter}---\n{body}\n"),
    )
    .unwrap();
    folder.scan().unwrap();
}

/// The edge create waiting in the queue, of which the test expects one.
fn waiting_create(folder: &Folder) -> QueuedWrite {
    let waiting = store::read_writes(
        &folder.core.conn().unwrap(),
        "WHERE verdict IS NULL AND kind = 'create_edge'",
        [],
    )
    .unwrap();
    assert_eq!(waiting.len(), 1, "{waiting:?}");
    waiting.into_iter().next().unwrap()
}

/// Answers each write still to be answered as a drain does: the server takes
/// it, but with `refuse` an edge create is refused for its one-to-one end,
/// which takes the create's edge back out of the copy.
fn answered(folder: &Folder, refuse: bool) {
    let conn = folder.core.conn().unwrap();
    for row in store::read_writes(&conn, "WHERE verdict IS NULL", []).unwrap() {
        store::mark_sent(&conn, &row.id).unwrap();
        if refuse && row.kind == WriteKind::CreateEdge {
            let answer = format!(r#"{{"error":{{"code":"{CONSTRAINT}","message":"one-to-one"}}}}"#);
            store::record_refusal(&conn, &row, CONSTRAINT, Some(&answer), false).unwrap();
        } else {
            store::record_verdict(
                &conn,
                &row.id,
                &Answered {
                    verdict: Verdict::Accepted,
                    reason: None,
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
        }
    }
}

/// A refused edge create as a drain left it: sent, answered, with its row
/// gone from the copy.
fn seeded(fixture: &Fixture, id: &str, edge_type: &str, properties: Value) -> String {
    seeded_at(fixture, id, "1", "refused", edge_type, properties)
}

fn seeded_at(
    fixture: &Fixture,
    id: &str,
    sent: &str,
    verdict: &str,
    edge_type: &str,
    properties: Value,
) -> String {
    let edge = format!("{id}-edge");
    let payload = json!({
        "id": edge,
        "source_id": fixture.source,
        "target_id": fixture.target,
        "edge_type": edge_type,
        "properties": properties,
    });
    fixture
        .folder
        .core
        .conn()
        .unwrap()
        .execute(
            "INSERT INTO queue (id, kind, item_id, target_id, edge_id, idempotency_key, payload,
                                sent, verdict, reason, answer, queued_at, answered_at)
             VALUES (?1, 'create_edge', ?2, ?3, ?4, ?1, ?5, ?6, ?7, ?8, '{}',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
            rusqlite::params![
                id,
                fixture.source,
                fixture.target,
                edge,
                payload.to_string(),
                sent,
                verdict,
                match verdict {
                    "refused" => Some(CONSTRAINT),
                    "blocked" => Some("conflict_unresolved"),
                    _ => None,
                },
            ],
        )
        .unwrap();
    id.to_string()
}

/// The edge as a read of the server's brings it.
fn held(fixture: &Fixture, id: &str, edge_type: &str, properties: Value) {
    let mut edge = store::testing::wire_edge(id, &fixture.source, &fixture.target, edge_type);
    edge.properties = properties.as_object().cloned().unwrap_or_default();
    store::put_server_edge(&fixture.folder.core.conn().unwrap(), &edge).unwrap();
}

fn ids(folder: &Folder) -> Vec<String> {
    folder
        .core
        .queue()
        .unwrap()
        .into_iter()
        .map(|row| row.id)
        .collect()
}

fn in_queue(folder: &Folder, id: &str) -> bool {
    ids(folder).iter().any(|held| held == id)
}

fn edges_of(folder: &Folder) -> Vec<(String, String, String, String, i64, String)> {
    let conn = folder.core.conn().unwrap();
    let mut statement = conn
        .prepare(
            "SELECT id, source_id, target_id, edge_type, version, properties FROM edges ORDER BY id",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn file_status(folder: &Folder, path: &str) -> FileStatus {
    folder
        .status()
        .unwrap()
        .files
        .into_iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("no status for {path}"))
}

fn execute(folder: &Folder, sql: &str, values: impl rusqlite::Params) {
    folder.core.conn().unwrap().execute(sql, values).unwrap();
}

/// Records on the file a refusal of the line, as a drain does.
fn flag_line(folder: &Folder, path: &str, change: state::Change) {
    let conn = folder.core.conn().unwrap();
    let mut bound = state::bound_at(&conn, path).unwrap().unwrap();
    bound.writes.refused.push(state::Refused {
        change,
        save: 1,
        reason: format!("{CONSTRAINT}: one-to-one"),
    });
    state::bind(&conn, &bound).unwrap();
}

fn unflag(folder: &Folder, path: &str) {
    let conn = folder.core.conn().unwrap();
    let mut bound = state::bound_at(&conn, path).unwrap().unwrap();
    bound.writes.refused.clear();
    bound.writes.landing = None;
    state::bind(&conn, &bound).unwrap();
}

#[test]
fn a_refused_edge_create_leaves_at_the_drain_after_the_server_holds_its_edge() {
    let fixture = fixture();
    let (dir, folder) = (fixture.dir.path(), &fixture.folder);
    lined(dir, folder, "a.md", &fixture.target, "first");
    let refused = waiting_create(folder).id;
    answered(folder, true);
    folder.drain().unwrap();
    assert_eq!(file_status(folder, "a.md").flag, Some("refused"));

    // Saved again, and this time the server takes it and the copy reads it.
    lined(dir, folder, "a.md", &fixture.target, "second");
    let taken = waiting_create(folder);
    answered(folder, false);
    held(
        &fixture,
        taken.edge_id.as_deref().unwrap(),
        ONE_TO_ONE,
        json!({}),
    );
    folder.drain().unwrap();
    assert!(
        in_queue(folder, &refused),
        "the witness: it stays while the file's flag was on as the drain began"
    );
    let file = file_status(folder, "a.md");
    assert_eq!((file.status, file.flag), ("in_step", None));

    let status = folder.status().unwrap();
    let edges = edges_of(folder);
    assert_eq!(
        edges.iter().filter(|edge| edge.3 == ONE_TO_ONE).count(),
        1,
        "{edges:?}"
    );
    let conn = folder.core.conn().unwrap();
    let copy = (
        store::copy_revision(&conn).unwrap(),
        store::last_change(&conn, store::Changes::Items).unwrap(),
        store::last_change(&conn, store::Changes::Edges).unwrap(),
    );
    drop(conn);
    let text = std::fs::read_to_string(dir.join("a.md")).unwrap();
    rendered();

    folder.drain().unwrap();

    assert_eq!(ids(folder), Vec::<String>::new());
    assert_eq!(folder.status().unwrap(), status);
    assert_eq!(edges_of(folder), edges);
    let conn = folder.core.conn().unwrap();
    assert_eq!(
        (
            store::copy_revision(&conn).unwrap(),
            store::last_change(&conn, store::Changes::Items).unwrap(),
            store::last_change(&conn, store::Changes::Edges).unwrap(),
        ),
        copy
    );
    drop(conn);
    assert_eq!(rendered(), 0);
    assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), text);
}

#[test]
fn identical_refused_creates_of_an_edge_held_under_another_id_all_go() {
    let fixture = fixture();
    for id in ["first", "second", "third"] {
        seeded(&fixture, id, ONE_TO_ONE, json!({}));
    }
    held(&fixture, "from-elsewhere", ONE_TO_ONE, json!({}));
    let status = fixture.folder.status().unwrap();
    let edges = edges_of(&fixture.folder);

    fixture.folder.drain().unwrap();

    assert_eq!(ids(&fixture.folder), Vec::<String>::new());
    assert_eq!(fixture.folder.status().unwrap(), status);
    assert_eq!(edges_of(&fixture.folder), edges);
}

#[test]
fn a_refused_create_of_an_edge_the_copy_does_not_hold_stays_until_it_is_discarded() {
    let fixture = fixture();
    let folder = &fixture.folder;
    let refused = seeded(&fixture, "refused", ONE_TO_ONE, json!({}));
    // An edge of the type at either end alone is not the edge asked for.
    let mut other_target =
        store::testing::wire_edge("other-target", &fixture.source, "elsewhere", ONE_TO_ONE);
    store::put_server_edge(&folder.core.conn().unwrap(), &other_target).unwrap();
    other_target.id = "other-source".into();
    other_target.source_id = "elsewhere".into();
    other_target.target_id = fixture.target.clone();
    store::put_server_edge(&folder.core.conn().unwrap(), &other_target).unwrap();
    held(&fixture, "other-type", "references", json!({}));

    folder.drain().unwrap();
    folder.drain().unwrap();
    assert!(in_queue(folder, &refused));

    assert!(store::discard(&folder.core.conn().unwrap(), &refused).unwrap());
    assert!(!in_queue(folder, &refused));
}

#[test]
fn a_refused_write_of_another_kind_stays_though_the_edge_is_held() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(&fixture, "edge", ONE_TO_ONE, json!({}));
    // The witness: a refused create beside them goes.
    let create = seeded(&fixture, "create", ONE_TO_ONE, json!({}));
    let conn = folder.core.conn().unwrap();
    conn.execute(
        "INSERT INTO queue (id, kind, item_id, target_id, edge_id, idempotency_key, payload,
                            sent, verdict, reason, answer, queued_at, answered_at)
         VALUES ('moved', 'update_edge', ?1, ?2, 'edge', 'moved', '{\"properties\":{}}',
                 1, 'refused', ?3, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
        [&fixture.source, &fixture.target, &CONSTRAINT.to_string()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO queue (id, kind, item_id, idempotency_key, payload,
                            sent, verdict, reason, answer, queued_at, answered_at)
         VALUES ('edited', 'update_item', ?1, 'edited', '{\"properties\":{\"body\":\"words\"}}',
                 1, 'refused', 'validation_error', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
        [&fixture.source],
    )
    .unwrap();
    drop(conn);

    folder.drain().unwrap();

    assert!(!in_queue(folder, &create));
    assert_eq!(ids(folder), ["moved", "edited"]);
}

#[test]
fn a_refused_create_another_write_is_tied_to_stays_until_that_write_has_gone() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(&fixture, "edge", ONE_TO_ONE, json!({}));
    let depended = seeded(&fixture, "depended", ONE_TO_ONE, json!({}));
    let followed = seeded(&fixture, "followed", ONE_TO_ONE, json!({}));
    for (id, column, value) in [
        ("depends", "depends_on", format!(r#"["{depended}"]"#)),
        ("follows", "follows", followed.clone()),
    ] {
        execute(
            folder,
            &format!(
                "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, {column},
                                    sent, verdict, reason, answer, queued_at, answered_at)
                 VALUES (?1, 'update_item', ?2, ?1, '{{\"properties\":{{\"body\":\"words\"}}}}', ?3,
                         1, 'refused', 'validation_error', '{{}}',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')"
            ),
            [id, &fixture.source, &value],
        );
    }

    folder.drain().unwrap();
    assert!(in_queue(folder, &depended));
    assert!(in_queue(folder, &followed));

    execute(folder, "DELETE FROM queue WHERE id = 'depends'", []);
    execute(folder, "DELETE FROM queue WHERE id = 'follows'", []);
    folder.drain().unwrap();
    assert!(!in_queue(folder, &depended));
    assert!(!in_queue(folder, &followed));
}

#[test]
fn a_refused_create_a_files_record_still_waits_on_stays() {
    let fixture = fixture();
    let (dir, folder) = (fixture.dir.path(), &fixture.folder);
    lined(dir, folder, "a.md", &fixture.target, "first");
    let refused = waiting_create(folder).id;
    answered(folder, true);
    held(&fixture, "edge", ONE_TO_ONE, json!({}));

    folder.clear_answered().unwrap();
    assert!(in_queue(folder, &refused));
    let bound = state::bound_at(&folder.core.conn().unwrap(), "a.md")
        .unwrap()
        .unwrap();
    assert!(
        bound
            .writes
            .queued
            .iter()
            .any(|queued| queued.id == refused),
        "{:?}",
        bound.writes
    );
}

#[test]
fn a_refused_create_a_files_flag_shows_stays_with_its_reason() {
    let fixture = fixture();
    let folder = &fixture.folder;
    let line = |end, other: &str| state::Line {
        edge_type: ONE_TO_ONE.into(),
        end,
        other: other.into(),
    };
    let on_source = line(End::Source, &fixture.target);
    let on_target = line(End::Target, &fixture.source);
    held(&fixture, "edge", ONE_TO_ONE, json!({}));

    let shown_by = [
        (
            "a.md",
            state::Change::Edge {
                line: on_source.clone(),
                shown: true,
            },
        ),
        (
            "t.md",
            state::Change::Edge {
                line: on_target.clone(),
                shown: true,
            },
        ),
        (
            "a.md",
            state::Change::DefaultEdge {
                line: on_source.clone(),
                file: false,
            },
        ),
    ];
    for (n, (path, change)) in shown_by.into_iter().enumerate() {
        let refused = seeded(&fixture, &format!("refused-{n}"), ONE_TO_ONE, json!({}));
        flag_line(folder, path, change);
        let before = folder.status().unwrap();

        folder.drain().unwrap();
        assert!(in_queue(folder, &refused), "shown on {path}");
        assert_eq!(folder.status().unwrap(), before);

        unflag(folder, path);
        folder.drain().unwrap();
        assert!(!in_queue(folder, &refused), "no flag on {path} shows it");
    }

    // A line to another item, and of another type, is another refusal.
    let refused = seeded(&fixture, "refused", ONE_TO_ONE, json!({}));
    flag_line(
        folder,
        "a.md",
        state::Change::Edge {
            line: line(End::Source, "elsewhere"),
            shown: true,
        },
    );
    flag_line(
        folder,
        "a.md",
        state::Change::Edge {
            line: state::Line {
                edge_type: "references".into(),
                end: End::Source,
                other: fixture.target.clone(),
            },
            shown: true,
        },
    );
    folder.drain().unwrap();
    assert!(!in_queue(folder, &refused));

    // A record a landing keeps shows it too.
    let refused = seeded(&fixture, "behind-landing", ONE_TO_ONE, json!({}));
    {
        let conn = folder.core.conn().unwrap();
        let mut bound = state::bound_at(&conn, "a.md").unwrap().unwrap();
        bound.writes.refused.clear();
        let mut before = bound.clone();
        before.writes.refused.push(state::Refused {
            change: state::Change::Edge {
                line: on_source,
                shown: true,
            },
            save: 1,
            reason: CONSTRAINT.into(),
        });
        bound.writes.landing = Some(state::Landing {
            before: Some(Box::new(before)),
        });
        state::bind(&conn, &bound).unwrap();
    }
    folder.clear_answered().unwrap();
    assert!(in_queue(folder, &refused));
}

#[test]
fn only_an_edge_the_server_gave_the_copy_proves_a_refused_create_satisfied() {
    let fixture = fixture();
    let folder = &fixture.folder;

    // The copy's own row, with no write left to it, and with one that cannot
    // go until a person acts.
    let refused = seeded(&fixture, "refused", ONE_TO_ONE, json!({}));
    let mut local =
        store::testing::wire_edge("local", &fixture.source, &fixture.target, ONE_TO_ONE);
    local.version = 0;
    store::upsert_edge(&folder.core.conn().unwrap(), &local).unwrap();
    folder.drain().unwrap();
    assert!(in_queue(folder, &refused), "a row of version 0");

    let dead = seeded_at(&fixture, "dead", "1", "dead", ONE_TO_ONE, json!({}));
    execute(
        folder,
        "UPDATE queue SET edge_id = 'local' WHERE id = ?1",
        [&dead],
    );
    folder.drain().unwrap();
    assert!(in_queue(folder, &refused), "a create set aside");
    assert!(in_queue(folder, &dead));
    execute(folder, "DELETE FROM queue WHERE id = ?1", [&dead]);
    execute(folder, "DELETE FROM edges WHERE id = 'local'", []);

    // A server's row a waiting move lays this edge over.
    let mut moved = store::testing::wire_edge("moved", &fixture.source, "elsewhere", ONE_TO_ONE);
    moved.version = 3;
    store::put_server_edge(&folder.core.conn().unwrap(), &moved).unwrap();
    execute(
        folder,
        "UPDATE edges SET target_id = ?1 WHERE id = 'moved'",
        [&fixture.target],
    );
    execute(
        folder,
        "INSERT INTO queue (id, kind, item_id, target_id, edge_id, idempotency_key, payload,
                            verdict, reason, queued_at, base_version)
         VALUES ('move', 'update_edge', ?1, ?2, 'moved', 'move', '{}', 'blocked', 'conflict_unresolved',
                 '2026-01-01T00:00:00Z', 3)",
        [&fixture.source, &fixture.target],
    );
    folder.clear_answered().unwrap();
    assert!(in_queue(folder, &refused), "a waiting move's edge");
    execute(folder, "DELETE FROM queue WHERE id = 'move'", []);
    execute(folder, "DELETE FROM edges WHERE id = 'moved'", []);

    // A server's row of which a refused write's read has yet to land.
    held(&fixture, "edge", ONE_TO_ONE, json!({}));
    execute(
        folder,
        "INSERT INTO read_backs (subject, id) VALUES ('edge', 'edge')",
        [],
    );
    folder.clear_answered().unwrap();
    assert!(in_queue(folder, &refused), "an edge with a read owed");

    // The witness: with all of that gone, the server's edge proves it.
    execute(folder, "DELETE FROM read_backs", []);
    folder.clear_answered().unwrap();
    assert!(!in_queue(folder, &refused));
}

#[test]
fn a_refused_create_carrying_what_the_held_edge_lacks_stays() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(
        &fixture,
        "edge",
        ONE_TO_ONE,
        json!({ "note": "held", "weight": 2 }),
    );
    let lacked = seeded(&fixture, "lacked", ONE_TO_ONE, json!({ "other": "words" }));
    let differs = seeded(
        &fixture,
        "differs",
        ONE_TO_ONE,
        json!({ "note": "refused" }),
    );
    let carried = seeded(&fixture, "carried", ONE_TO_ONE, json!({ "note": "held" }));
    let empty = seeded(&fixture, "empty", ONE_TO_ONE, json!({}));

    folder.drain().unwrap();

    assert!(in_queue(folder, &lacked));
    assert!(in_queue(folder, &differs));
    assert!(!in_queue(folder, &carried), "the held edge carries it");
    assert!(!in_queue(folder, &empty), "the held edge carries it");
}

#[test]
fn a_refused_placement_stays_for_the_folder_to_settle() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(&fixture, "placed", placement::PLACEMENT_EDGE, json!({}));
    let refused = seeded(&fixture, "refused", placement::PLACEMENT_EDGE, json!({}));
    folder.clear_answered().unwrap();
    assert!(in_queue(folder, &refused));
}

#[test]
fn a_refused_create_with_a_read_or_a_receipt_owed_stays() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(&fixture, "edge", ONE_TO_ONE, json!({}));
    let read = seeded(&fixture, "read", ONE_TO_ONE, json!({}));
    execute(
        folder,
        "INSERT INTO read_backs (subject, id) VALUES ('edge', 'read-edge')",
        [],
    );
    let receipt = seeded(&fixture, "receipt", ONE_TO_ONE, json!({}));
    store::meta_set(
        &folder.core.conn().unwrap(),
        "receipt_pending/receipt",
        "edge",
    )
    .unwrap();
    let unsent = seeded_at(&fixture, "unsent", "0", "refused", ONE_TO_ONE, json!({}));
    // The witness: one with none of those goes.
    let plain = seeded(&fixture, "plain", ONE_TO_ONE, json!({}));

    folder.clear_answered().unwrap();

    assert!(in_queue(folder, &read));
    assert!(in_queue(folder, &receipt));
    assert!(in_queue(folder, &unsent));
    assert!(!in_queue(folder, &plain));
}

#[test]
fn a_refused_create_whose_payload_names_no_edge_stays_and_stops_no_drain() {
    let fixture = fixture();
    let folder = &fixture.folder;
    held(&fixture, "edge", ONE_TO_ONE, json!({}));
    let damaged = seeded(&fixture, "damaged", ONE_TO_ONE, json!({}));
    execute(
        folder,
        "UPDATE queue SET payload = '{}' WHERE id = ?1",
        [&damaged],
    );
    let plain = seeded(&fixture, "plain", ONE_TO_ONE, json!({}));

    folder.drain().unwrap();

    assert!(in_queue(folder, &damaged));
    assert!(!in_queue(folder, &plain));
}

#[test]
fn the_queue_holds_one_refused_create_of_a_line_however_often_the_file_is_saved() {
    let fixture = fixture();
    let (dir, folder) = (fixture.dir.path(), &fixture.folder);
    let mut each = Vec::new();
    for edit in 0..4 {
        lined(
            dir,
            folder,
            "a.md",
            &fixture.target,
            &format!("edit {edit}"),
        );
        each.push(waiting_create(folder).id);
        answered(folder, true);
        folder.drain().unwrap();
    }
    each.dedup();
    assert_eq!(
        each.len(),
        4,
        "the witness: each save queued its own create"
    );
    let left: Vec<String> = store::read_writes(
        &folder.core.conn().unwrap(),
        "WHERE kind = 'create_edge'",
        [],
    )
    .unwrap()
    .into_iter()
    .map(|row| row.id)
    .collect();
    assert_eq!(left, [each[3].clone()]);
    let file = file_status(folder, "a.md");
    assert_eq!(file.flag, Some("refused"));
    assert!(
        file.reason
            .as_deref()
            .is_some_and(|why| why.contains(CONSTRAINT)),
        "{file:?}"
    );
}

#[test]
fn an_older_refused_create_goes_when_the_same_create_is_queued_and_the_flag_keeps_its_reason() {
    let fixture = fixture();
    let (dir, folder) = (fixture.dir.path(), &fixture.folder);
    lined(dir, folder, "a.md", &fixture.target, "first");
    let older = waiting_create(folder).id;
    answered(folder, true);
    folder.drain().unwrap();
    let flagged = file_status(folder, "a.md");
    assert_eq!(flagged.flag, Some("refused"));

    lined(dir, folder, "a.md", &fixture.target, "second");
    let newer = waiting_create(folder).id;
    assert!(in_queue(folder, &older), "the witness: both are queued");

    folder.clear_answered().unwrap();

    assert!(!in_queue(folder, &older));
    assert!(in_queue(folder, &newer));
    assert_eq!(file_status(folder, "a.md").reason, flagged.reason);
}

#[test]
fn an_older_refused_create_stays_where_a_later_one_does_not_carry_it() {
    let fixture = fixture();
    let folder = &fixture.folder;
    // Carries what the later create lacks, and a value it changes.
    let lacks = seeded(&fixture, "lacks", ONE_TO_ONE, json!({ "gone": "words" }));
    let changes = seeded(&fixture, "changes", ONE_TO_ONE, json!({ "note": "before" }));
    // Carried, the later create adding to it.
    let carried = seeded(&fixture, "carried", ONE_TO_ONE, json!({ "note": "after" }));
    // Older than a create of another type.
    let other_type = seeded(&fixture, "other-type", "references", json!({}));
    let later = seeded(
        &fixture,
        "later",
        ONE_TO_ONE,
        json!({ "note": "after", "more": 1 }),
    );

    folder.clear_answered().unwrap();

    assert!(in_queue(folder, &lacks));
    assert!(in_queue(folder, &changes));
    assert!(!in_queue(folder, &carried));
    assert!(in_queue(folder, &other_type));
    assert!(
        in_queue(folder, &later),
        "the newest stays for a person to see"
    );
}

#[test]
fn a_later_create_that_may_never_be_sent_does_not_take_an_older_refused_one_with_it() {
    let fixture = fixture();
    let folder = &fixture.folder;
    let older = seeded(&fixture, "older", ONE_TO_ONE, json!({}));
    for (id, sent, verdict) in [
        ("taken", "1", "accepted"),
        ("set-aside", "1", "dead"),
        ("held-back", "0", "refused"),
    ] {
        seeded_at(&fixture, id, sent, verdict, ONE_TO_ONE, json!({}));
        folder.clear_answered().unwrap();
        assert!(in_queue(folder, &older), "behind a create {id}");
        execute(folder, "DELETE FROM queue WHERE id = ?1", [id]);
    }

    // The witness: a create still to be sent, or refused by the server, does.
    seeded_at(&fixture, "blocked", "0", "blocked", ONE_TO_ONE, json!({}));
    folder.clear_answered().unwrap();
    assert!(!in_queue(folder, &older));
}

/// A store as the last release wrote it: the rows that release left, in the
/// tables as they stood, with an edge read from the server.
#[test]
fn a_store_holding_such_rows_clears_them_with_no_change_of_format() {
    let shape = |folder: &Folder| {
        let conn = folder.core.conn().unwrap();
        let mut statement = conn
            .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .unwrap();
        let tables: Vec<(String, String, Option<String>)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        (tables, version)
    };
    let fixture = fixture();
    for id in ["31-october", "1-november", "1-november-later"] {
        seeded(&fixture, id, ONE_TO_ONE, json!({}));
    }
    held(&fixture, "from-elsewhere", ONE_TO_ONE, json!({}));
    let before = shape(&fixture.folder);
    let status = fixture.folder.status().unwrap();
    let root = fixture.dir.path().to_path_buf();
    let url = fixture._server.url();
    let Fixture {
        dir,
        folder,
        _server: server,
        ..
    } = fixture;
    drop(folder);

    let folder = Folder::open(
        &root,
        Some(crate::Server {
            url,
            key: "fixture".into(),
        }),
    )
    .unwrap();
    assert_eq!(shape(&folder), before);
    folder.drain().unwrap();

    assert_eq!(ids(&folder), Vec::<String>::new());
    assert_eq!(shape(&folder), before);
    assert_eq!(folder.status().unwrap(), status);
    drop((dir, server));
}
