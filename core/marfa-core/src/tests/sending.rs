use super::*;

#[test]
fn a_refusal_puts_back_what_was_beneath_the_write_and_keeps_what_still_waits() {
    let core = held_copy();
    let tagged = core.add_tag("row", "b").unwrap();
    let edited = core
        .update_item(
            "row",
            &Edit {
                properties: serde_json::json!({ "title": "mine" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(3),
                ..Edit::default()
            },
        )
        .unwrap();
    let archived = core
        .transition_item_from("row", ItemState::Archived, None)
        .unwrap();
    let unlinked = core.delete_edge("link").unwrap();
    let held = || core.get("row").unwrap().unwrap();
    assert_eq!(held().properties["title"], "mine");

    // The tag lands with an answer carrying no row, so the row beneath
    // the writes still waiting holds it too.
    {
        let conn = core.conn().unwrap();
        store::record_verdict(
            &conn,
            &tagged.id,
            &store::Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        let mut baseline = store::testing::note("row", "server", "body", "2026-01-01T00:00:00Z");
        baseline.version = 3;
        store::put_server_item(
            &conn,
            &baseline,
            Some(&["a".into(), "b".into()]),
            &marfa_rules::catalog::Catalog::empty(),
        )
        .unwrap();
        store::lay_waiting_writes_over(&conn, "row", &|_| {
            marfa_rules::catalog::Indexing::default()
        })
        .unwrap();
    }
    refuse(&core, &edited);
    assert_eq!(
        held().properties["title"],
        "server",
        "the copy went on showing an edit the server refused"
    );
    assert_eq!(
        held().state,
        ItemState::Archived,
        "a write still waiting was undone with the refused one"
    );
    assert_eq!(
        held().tags,
        ["a", "b"],
        "a tag the server took was undone by a refusal behind it"
    );
    assert_eq!(held().version, 3);

    refuse(&core, &archived);
    assert_eq!(held().state, ItemState::Active);
    assert_eq!(held().tags, ["a", "b"]);

    assert!(core.edges_from("row").unwrap().is_empty());
    refuse(&core, &unlinked);
    assert_eq!(
        core.edges_from("row").unwrap().len(),
        1,
        "a refused delete of an edge left the edge gone from the copy"
    );
    let conn = core.conn().unwrap();
    assert_eq!(
        store::beneath_item(&conn, "row").unwrap(),
        None,
        "a row with nothing waiting on it kept a row beneath"
    );
}

#[test]
fn a_refused_write_with_content_stays_through_a_clearing_until_it_is_discarded() {
    let core = held_copy();
    let edited = core
        .update_item(
            "row",
            &Edit {
                properties: serde_json::json!({ "title": "the words" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(3),
                ..Edit::default()
            },
        )
        .unwrap();
    let tagged = core.add_tag("row", "b").unwrap();
    refuse(&core, &edited);
    refuse(&core, &tagged);
    assert_eq!(
        core.forget_answered().unwrap(),
        1,
        "the clearing took the refused edit, or kept the refused tag"
    );
    let queue = core.queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].body["properties"]["title"], "the words");
    assert!(matches!(
        queue[0].outcome().unwrap(),
        Some(Outcome::Refused(Refusal { ref reason, .. })) if reason == "type_not_permitted"
    ));
    assert!(!core.discard(&tagged.id).is_ok_and(|taken| taken));
    assert!(core.discard(&edited.id).unwrap());
    assert!(core.queue().unwrap().is_empty());
}

#[test]
fn forgetting_named_answered_writes_keeps_every_other_answer() {
    let core = held_copy();
    let first = core.add_tag("row", "b").unwrap();
    let second = core.add_tag("row", "c").unwrap();
    let unanswered = core.add_tag("row", "d").unwrap();
    for write in [&first, &second] {
        let mut conn = core.conn().unwrap();
        store::mark_sent(&conn, &write.id).unwrap();
        store::record_verdict(
            &conn,
            &write.id,
            &store::Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        body::rule::after_answers(&mut conn).unwrap();
    }
    let ids = |core: &Core| {
        core.queue()
            .unwrap()
            .into_iter()
            .map(|write| write.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        core.forget_answered_ids(&[
            first.id.clone(),
            unanswered.id.clone(),
            "no-such-write".into()
        ])
        .unwrap(),
        1,
        "the named answered write was kept, or one not answered or not held was counted"
    );
    assert_eq!(
        ids(&core),
        vec![second.id.clone(), unanswered.id.clone()],
        "an answer nobody named was forgotten with the one that was, so an app never reads it"
    );
    // The witness: an unrestricted clearing takes the answer kept above.
    assert_eq!(core.forget_answered().unwrap(), 1);
    assert_eq!(ids(&core), vec![unanswered.id.clone()]);
}

/// A held copy whose queue holds a refused edit with content, a refused
/// tag, an accepted tag and a tag still waiting, with their ids in that
/// order.
fn answered_queue() -> (Core, [String; 4]) {
    let core = held_copy();
    let edited = core
        .update_item(
            "row",
            &Edit {
                properties: serde_json::json!({ "title": "the words" })
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(3),
                ..Edit::default()
            },
        )
        .unwrap();
    let refused = core.add_tag("row", "b").unwrap();
    let accepted = core.add_tag("row", "c").unwrap();
    let waiting = core.add_tag("row", "d").unwrap();
    refuse(&core, &edited);
    refuse(&core, &refused);
    {
        let conn = core.conn().unwrap();
        store::mark_sent(&conn, &accepted.id).unwrap();
        store::record_verdict(
            &conn,
            &accepted.id,
            &store::Answered {
                verdict: Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
    }
    (core, [edited.id, refused.id, accepted.id, waiting.id])
}

#[test]
fn taking_answered_writes_returns_what_a_clearing_takes_as_the_queue_showed_it() {
    let (core, [edited, refused, accepted, waiting]) = answered_queue();
    let before = core.queue().unwrap();
    let taken = core.take_answered().unwrap();
    let shown: Vec<_> = before
        .into_iter()
        .filter(|write| write.id == refused || write.id == accepted)
        .collect();
    assert_eq!(
        taken, shown,
        "a take returned other writes than the answered ones it cleared, or not as the queue showed them"
    );
    let left: Vec<_> = core.queue().unwrap().into_iter().map(|w| w.id).collect();
    assert_eq!(
        left,
        vec![edited.clone(), waiting],
        "a take cleared the refused edit's content, or a write with no answer"
    );
    assert_eq!(core.take_answered().unwrap(), Vec::new());
}

#[test]
fn taking_answered_writes_clears_what_forgetting_them_clears() {
    let (taker, taker_ids) = answered_queue();
    let (forgetter, forgetter_ids) = answered_queue();
    let taken = taker.take_answered().unwrap().len();
    assert_eq!(forgetter.forget_answered().unwrap(), taken);
    // Each copy mints its own ids, so a write is named by its place.
    let left = |core: &Core, ids: &[String; 4]| {
        core.queue()
            .unwrap()
            .into_iter()
            .map(|write| ids.iter().position(|id| *id == write.id))
            .collect::<Vec<_>>()
    };
    assert_eq!(left(&taker, &taker_ids), left(&forgetter, &forgetter_ids));
}

#[cfg(debug_assertions)]
#[test]
fn two_takes_at_once_each_return_a_write_to_one_of_them() {
    let (core, [_, refused, accepted, _]) = answered_queue();
    let point = "answered-taking";
    crate::fault::arm(point);
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| core.take_answered());
        let waited = std::time::Instant::now();
        while crate::fault::waiting(point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the first take never reached its read"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let second = scope.spawn(|| core.take_answered());
        std::thread::sleep(std::time::Duration::from_millis(100));
        crate::fault::release(point);
        (
            first.join().unwrap().unwrap(),
            second.join().unwrap().unwrap(),
        )
    });
    let ids = |taken: &[QueuedWrite]| taken.iter().map(|w| w.id.clone()).collect::<Vec<_>>();
    let (first, second) = (ids(&first), ids(&second));
    assert!(
        first.iter().all(|id| !second.contains(id)),
        "both takes returned one answer: {first:?} and {second:?}"
    );
    let mut every = [first, second].concat();
    every.sort();
    let mut answered = vec![refused, accepted];
    answered.sort();
    assert_eq!(
        every, answered,
        "an answer was cleared and returned to neither take"
    );
}

#[test]
fn a_release_by_reason_releases_that_reason_and_no_other() {
    let core = Core::open_in_memory(None).unwrap();
    {
        let conn = core.conn().unwrap();
        for reason in [BlockedReason::KeySpent, BlockedReason::ConflictUnresolved] {
            conn.execute(
                "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', 'blocked', ?1, 1, '2026-01-01T00:00:00Z')",
                [reason.as_str()],
            )
            .unwrap();
        }
        // A dead row carrying the reason's own text, so a release that
        // read the reason column without the verdict would take it too.
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, queued_at)
             VALUES ('dead', 'update_item', 'dead', '{}', 'dead', 'key_spent', 1, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }
    assert_eq!(core.release_reason(BlockedReason::KeySpent).unwrap(), 1);
    let rows = core.queue().unwrap();
    let still = |id: &str| rows.iter().find(|row| row.id == id).unwrap().verdict;
    assert_eq!(still("key_spent"), None);
    assert_eq!(
        still("conflict_unresolved"),
        Some(Verdict::Blocked),
        "a release by one reason released a row blocked for another"
    );
    assert_eq!(
        still("dead"),
        Some(Verdict::Dead),
        "a release by reason released a dead write, which is released one id at a time"
    );
    assert!(core.release("dead").unwrap());
    assert_eq!(
        core.queue()
            .unwrap()
            .iter()
            .find(|row| row.id == "dead")
            .unwrap()
            .verdict,
        None
    );
}
