//! A folder clears the answered writes it has recorded what it needs from,
//! so its queue, and what each drain reads, stay the size of what is still to
//! be answered or kept, however many writes the folder has sent.

use std::path::Path;

use super::tests::watched_notes;
use super::*;
use crate::model::{QueuedWrite, Verdict, WriteKind};
use crate::store::{self, Answered, ROWS_READ};

/// The queue rows this thread read since the last call.
fn rows_read() -> usize {
    ROWS_READ.with(|read| read.replace(0))
}

fn queue(folder: &Folder) -> Vec<QueuedWrite> {
    folder.core.queue().unwrap()
}

fn item_of(folder: &Folder, path: &str) -> String {
    state::bound_at(&folder.core.conn().unwrap(), path)
        .unwrap()
        .unwrap()
        .item_id
}

/// Writes the note's body as `body` below the frontmatter the folder wrote,
/// and scans.
fn edited(dir: &Path, folder: &Folder, name: &str, body: &str) {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path).unwrap();
    let end = text
        .strip_prefix("---\n")
        .and_then(|rest| rest.find("\n---\n"))
        .unwrap_or_else(|| panic!("{name} has no frontmatter: {text}"));
    let frontmatter = &text[..end + "---\n".len() + "\n---\n".len()];
    std::fs::write(&path, format!("{frontmatter}{body}\n")).unwrap();
    folder.scan().unwrap();
}

/// Gives the note the tag `tag` in the frontmatter the folder wrote, keeping
/// its version line, and scans.
fn tagged(dir: &Path, folder: &Folder, name: &str, tag: &str) {
    let path = dir.join(name);
    let text = std::fs::read_to_string(&path).unwrap();
    let rest = text
        .strip_prefix("---\n")
        .unwrap_or_else(|| panic!("{name} has no frontmatter: {text}"));
    let rest: String = rest
        .split_inclusive('\n')
        .filter(|line| !line.starts_with("tags:"))
        .collect();
    std::fs::write(&path, format!("---\ntags: [{tag}]\n{rest}")).unwrap();
    folder.scan().unwrap();
}

/// Sends each write still to be answered and records `verdict` for it, as a
/// drain does before the folder reads the answers. Answers the writes.
fn answered(folder: &Folder, verdict: Verdict, copy: Option<&str>) -> Vec<QueuedWrite> {
    let conn = folder.core.conn().unwrap();
    let waiting = store::read_writes(&conn, "WHERE verdict IS NULL", []).unwrap();
    let answer = r#"{"error":{"code":"validation_error","message":"not taken"}}"#;
    for row in &waiting {
        store::mark_sent(&conn, &row.id).unwrap();
        store::record_verdict(
            &conn,
            &row.id,
            &Answered {
                verdict,
                reason: (verdict == Verdict::Refused).then_some("validation_error"),
                answer: (verdict == Verdict::Refused).then_some(answer),
                conflicted_copy_id: copy,
            },
        )
        .unwrap();
    }
    waiting
}

/// Puts `count` writes to `item` in the queue, sent and taken, that no file
/// waits on, as every edit an earlier build sent was left.
fn sent_long_ago(folder: &Folder, item: &str, count: usize) -> Vec<String> {
    let conn = folder.core.conn().unwrap();
    (0..count)
        .map(|n| {
            let id = format!("long-ago-{n}");
            conn.execute(
                "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, sent, verdict, queued_at, answered_at)
                 VALUES (?1, 'update_item', ?2, ?1, '{\"properties\":{\"body\":\"then\"}}', 1, 'accepted',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z')",
                [&id, item],
            )
            .unwrap();
            id
        })
        .collect()
}

fn flagged(folder: &Folder, path: &str) -> (Option<&'static str>, Option<String>) {
    let file = folder
        .status()
        .unwrap()
        .files
        .into_iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("no status for {path}"));
    (file.flag, file.reason)
}

fn refused_in_status(folder: &Folder, path: &str) -> bool {
    let (flag, reason) = flagged(folder, path);
    flag == Some("refused") && reason.is_some_and(|reason| reason.contains("validation_error"))
}

#[test]
fn a_folder_that_sent_hundreds_of_edits_keeps_only_what_it_still_needs() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md"]);
    for n in 0..300 {
        edited(dir.path(), &folder, "a.md", &format!("edit {n}"));
        assert!(
            !answered(&folder, Verdict::Accepted, None).is_empty(),
            "edit {n} queued no write"
        );
        folder.drain().unwrap();
    }
    let left = queue(&folder);
    assert!(
        left.len() <= 1,
        "{} answered writes stayed in the queue",
        left.len()
    );
}

#[test]
fn the_rows_a_drain_reads_do_not_grow_with_the_writes_the_folder_sent() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    let mut sent = 0;
    let mut reads_after = |edits: usize| {
        for _ in 0..edits {
            edited(dir.path(), &folder, "a.md", &format!("edit {sent}"));
            answered(&folder, Verdict::Accepted, None);
            folder.drain().unwrap();
            sent += 1;
        }
        edited(dir.path(), &folder, "b.md", &format!("edit {sent}"));
        answered(&folder, Verdict::Accepted, None);
        rows_read();
        folder.drain().unwrap();
        rows_read()
    };
    let after_twenty = reads_after(20);
    assert!(
        after_twenty > 0,
        "the witness: the drain read the answer the file waited on"
    );
    let after_two_hundred_more = reads_after(200);
    assert_eq!(after_two_hundred_more, after_twenty);
}

#[test]
fn a_drain_reads_the_writes_its_files_wait_on_by_id_not_the_whole_queue() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    // As an earlier build left them, before a drain clears them.
    sent_long_ago(&folder, &item_of(&folder, "b.md"), 500);
    edited(dir.path(), &folder, "a.md", "edited");
    let edit = answered(&folder, Verdict::Accepted, None);
    rows_read();
    folder.hold_refused().unwrap();
    folder.make_edges_gone_before_their_move().unwrap();
    folder.rebase_thinned().unwrap();
    let read = rows_read();
    assert!(read <= edit.len(), "read {read} queue rows");
    // The witness: the answer the file waited on was read, and recorded.
    let bound = state::bound_at(&folder.core.conn().unwrap(), "a.md")
        .unwrap()
        .unwrap();
    assert!(
        edit.iter().all(|write| bound
            .writes
            .queued
            .iter()
            .all(|queued| queued.id != write.id)),
        "{:?}",
        bound.writes.queued
    );
}

#[test]
fn a_refused_edit_keeps_its_words_and_a_refused_tag_its_reason_once_the_answers_are_cleared() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    edited(dir.path(), &folder, "a.md", "words the server refused");
    tagged(dir.path(), &folder, "b.md", "kept");
    let refused = answered(&folder, Verdict::Refused, None);
    assert!(
        refused.iter().any(|row| row.kind == WriteKind::AddTag),
        "the witness: the tag was sent, {refused:?}"
    );
    folder.drain().unwrap();
    let before = folder.status().unwrap();
    assert!(refused_in_status(&folder, "a.md"), "{before:?}");
    assert!(refused_in_status(&folder, "b.md"), "{before:?}");

    folder.drain().unwrap();
    folder.drain().unwrap();
    assert_eq!(folder.status().unwrap(), before);
    let left = queue(&folder);
    assert!(
        left.iter().any(|row| row.kind == WriteKind::UpdateItem
            && row.verdict == Some(Verdict::Refused)
            && store::payload_of(&folder.core.conn().unwrap(), &row.id)
                .unwrap()
                .contains("words the server refused")),
        "the refused edit's words left the queue: {left:?}"
    );
    assert!(
        !left.iter().any(|row| row.kind == WriteKind::AddTag),
        "the refused tag, which carries nothing, stayed: {left:?}"
    );
}

#[test]
fn a_conflicted_copy_stays_with_its_original_once_the_conflicted_edit_is_cleared() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    let (original, copy) = (item_of(&folder, "a.md"), item_of(&folder, "b.md"));
    edited(dir.path(), &folder, "a.md", "kept on the copy");
    // As a drain's read-back takes in the conflicted copy the server made.
    {
        let conn = folder.core.conn().unwrap();
        store::add_tags(&conn, &copy, &[crate::CONFLICTED_COPY_TAG.into()]).unwrap();
        store::upsert_edge(
            &conn,
            &store::testing::wire_edge("derivation", &copy, &original, crate::CONFLICTED_COPY_EDGE),
        )
        .unwrap();
    }
    answered(&folder, Verdict::Conflicted, Some(&copy));
    folder.drain().unwrap();
    let before = folder.status().unwrap();
    let copies = |folder: &Folder| {
        folder
            .core
            .conflicted_copies_of(&original)
            .unwrap()
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(copies(&folder), std::slice::from_ref(&copy));

    folder.drain().unwrap();
    folder.drain().unwrap();
    assert!(
        !queue(&folder)
            .iter()
            .any(|row| row.verdict == Some(Verdict::Conflicted)),
        "the witness: the conflicted edit left the queue"
    );
    assert_eq!(copies(&folder), std::slice::from_ref(&copy));
    assert_eq!(
        folder.core.original_of_conflicted_copy(&copy).unwrap(),
        Some(original)
    );
    assert_eq!(folder.status().unwrap(), before);
}

#[test]
fn a_store_holding_thousands_of_answered_writes_is_cleared_on_its_first_pass_without_losing_a_refusal()
 {
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md", "b.md"]);
    sent_long_ago(&folder, &item_of(&folder, "a.md"), 3000);
    // Refused, and not yet recorded against the file, as an earlier build
    // that stopped between the two left it.
    edited(dir.path(), &folder, "b.md", "words the server refused");
    let refused = answered(&folder, Verdict::Refused, None);
    assert!(queue(&folder).len() > 3000);

    passes.run(&folder, true).unwrap();
    assert_eq!(
        queue(&folder)
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        refused
            .iter()
            .filter(|row| row.kind == WriteKind::UpdateItem)
            .map(|row| row.id.clone())
            .collect::<Vec<_>>(),
        "the queue holds more than the refused edit"
    );
    assert!(refused_in_status(&folder, "b.md"));
}

#[test]
fn an_answer_recorded_before_the_folder_read_it_stays_until_the_file_records_it() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    tagged(dir.path(), &folder, "a.md", "kept");
    // A drain recorded the refusal and the process ended before the folder
    // read it.
    let refused = answered(&folder, Verdict::Refused, None);
    let tag = refused
        .iter()
        .find(|row| row.kind == WriteKind::AddTag)
        .expect("the tag was sent")
        .id
        .clone();
    let unnamed = sent_long_ago(&folder, &item_of(&folder, "b.md"), 1);

    assert_eq!(folder.clear_answered().unwrap(), 1);
    let ids: Vec<String> = queue(&folder).into_iter().map(|row| row.id).collect();
    assert!(ids.contains(&tag), "{ids:?}");
    assert!(!ids.contains(&unnamed[0]), "the witness: {ids:?}");

    folder.drain().unwrap();
    assert!(refused_in_status(&folder, "a.md"));
    folder.drain().unwrap();
    assert!(!queue(&folder).iter().any(|row| row.id == tag));
    assert!(refused_in_status(&folder, "a.md"));
}

#[test]
fn a_drain_cut_short_by_a_rate_limit_records_its_answers_before_they_leave_the_queue() {
    let (dir, folder, server, _passes) = watched_notes(&["a.md", "b.md"]);
    tagged(dir.path(), &folder, "a.md", "kept");
    let refused = answered(&folder, Verdict::Refused, None);
    edited(dir.path(), &folder, "b.md", "sent later");
    let b = item_of(&folder, "b.md");
    server.on(
        &format!("/items/{b}"),
        (0..4)
            .map(|_| crate::scripted::refusal(429, "rate_limited"))
            .collect(),
    );

    let cut = folder.drain().unwrap();
    assert!(cut.report.unavailable.is_some(), "{cut:?}");
    assert!(refused_in_status(&folder, "a.md"));
    folder.drain().unwrap();
    let left = queue(&folder);
    assert!(
        refused
            .iter()
            .filter(|row| row.kind == WriteKind::AddTag)
            .all(|tag| left.iter().all(|row| row.id != tag.id)),
        "{left:?}"
    );
    assert!(
        left.iter()
            .any(|row| row.item_id.as_deref() == Some(b.as_str()) && row.verdict.is_none()),
        "the edit the server could not take left the queue: {left:?}"
    );
    assert!(refused_in_status(&folder, "a.md"));
}

#[test]
fn a_drain_with_nothing_to_send_clears_the_answers_and_leaves_the_copy_as_it_was() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md"]);
    edited(dir.path(), &folder, "a.md", "edited");
    let edit = answered(&folder, Verdict::Accepted, None);
    // The file's record waits on the answer, so this drain keeps it.
    folder.drain().unwrap();
    assert!(
        queue(&folder).iter().any(|row| row.id == edit[0].id),
        "the witness: the answer is in the queue"
    );
    let marks = || {
        let conn = folder.core.conn().unwrap();
        (
            store::copy_revision(&conn).unwrap(),
            store::last_change(&conn, store::Changes::Items).unwrap(),
        )
    };
    let before = marks();

    folder.drain().unwrap();
    assert_eq!(queue(&folder), []);
    assert_eq!(marks(), before, "clearing an answer changed the copy");
}

#[test]
fn clearing_an_answered_edit_renders_its_file_no_more() {
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md", "b.md"]);
    let (a, b) = (item_of(&folder, "a.md"), item_of(&folder, "b.md"));
    edited(dir.path(), &folder, "a.md", "edited");
    let edit = answered(&folder, Verdict::Accepted, None);
    // The pass reads the answer and renders the file its answer reached;
    // the file's record waited on it, so the pass kept it in the queue.
    passes.run(&folder, false).unwrap();
    assert!(
        queue(&folder).iter().any(|row| row.id == edit[0].id),
        "the witness: the answer is in the queue"
    );
    super::tests::rendered();

    edited(dir.path(), &folder, "b.md", "edited too");
    answered(&folder, Verdict::Accepted, None);
    passes.run(&folder, false).unwrap();
    assert!(
        !queue(&folder).iter().any(|row| row.id == edit[0].id),
        "the pass kept the answer"
    );
    let rendered = super::tests::rendered_items();
    assert!(
        !rendered.contains(&a),
        "a.md was rendered again: {rendered:?}"
    );
    assert!(rendered.iter().all(|id| *id == b), "{rendered:?}");
}

#[test]
fn a_write_whose_read_after_its_answer_is_owed_stays() {
    let (_dir, folder, _server, _passes) = watched_notes(&["a.md"]);
    let ids = sent_long_ago(&folder, &item_of(&folder, "a.md"), 2);
    store::meta_set(
        &folder.core.conn().unwrap(),
        &format!("receipt_pending/{}", ids[0]),
        "refused",
    )
    .unwrap();
    assert_eq!(folder.clear_answered().unwrap(), 1, "the witness");
    assert_eq!(
        queue(&folder)
            .into_iter()
            .map(|row| row.id)
            .collect::<Vec<_>>(),
        [ids[0].clone()]
    );
}

#[test]
fn the_body_write_a_waiting_link_edge_was_read_from_stays() {
    let (_dir, folder, _server, _passes) = watched_notes(&["a.md", "b.md"]);
    let (host, other) = (item_of(&folder, "a.md"), item_of(&folder, "b.md"));
    let ids = sent_long_ago(&folder, &host, 2);
    {
        let conn = folder.core.conn().unwrap();
        // As `body::rule::derive` queues it: waiting on the body write.
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, target_id, idempotency_key, payload, queued_at, depends_on)
             VALUES ('link', 'create_edge', ?1, ?2, 'link', '{\"edge_type\":\"references\"}',
                     '2026-01-01T00:00:02Z', json_array(?3))",
            [&host, &other, &ids[0]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO body_edges (write_id, item_id, kind, other_id, body_write)
             VALUES ('link', ?1, 'link', ?2, ?3)",
            [&host, &other, &ids[0]],
        )
        .unwrap();
    }
    assert_eq!(folder.clear_answered().unwrap(), 1, "the witness");
    let left: Vec<String> = queue(&folder).into_iter().map(|row| row.id).collect();
    assert_eq!(left, [ids[0].clone(), "link".to_string()]);
}
