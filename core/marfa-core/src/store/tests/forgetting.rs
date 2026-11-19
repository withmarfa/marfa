use super::testing::*;
use super::*;

#[test]
fn forgetting_spares_every_row_a_caller_can_still_release() {
    let conn = conn();
    let row = |id: &str, verdict: &str, sent: i64, depends: &str| {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at)
                 VALUES (?1, 'update_item', ?1, '{}', ?2, ?3, ?4, '2026-01-01T00:00:00Z')",
            params![id, verdict, sent, depends],
        )
        .unwrap();
    };
    row("plain", "accepted", 1, "[]");
    row("unsent", "refused", 0, "[]");
    row("dependency", "refused", 1, "[]");
    row("dependant", "blocked", 1, "[\"dependency\"]");
    row("kept-for-unsent", "accepted", 1, "[]");
    row("unsent-waiter", "refused", 0, "[\"kept-for-unsent\"]");
    row("merged", "merged", 1, "[]");
    row("conflicted", "conflicted", 1, "[]");
    row("dead", "dead", 1, "[]");
    row("kept-for-dead", "accepted", 1, "[]");
    row("dead-waiter", "dead", 1, "[\"kept-for-dead\"]");

    let cleared = forget_answered(&conn).unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT id FROM queue ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(
        left,
        vec![
            "dead".to_string(),
            "dead-waiter".to_string(),
            "dependant".to_string(),
            "dependency".to_string(),
            "kept-for-dead".to_string(),
            "kept-for-unsent".to_string(),
            "unsent".to_string(),
            "unsent-waiter".to_string()
        ],
        "a row a caller can still release, or one a releasable row waits on, \
             was cleared: releasing then produces a write whose dependency cannot \
             be found, which reads as unanswered and is held forever"
    );
    assert_eq!(
        cleared, 3,
        "nothing was cleared, so the queue grows without bound and every \
             later write reads a longer one"
    );
}

fn queue_row(
    conn: &Connection,
    id: &str,
    kind: &str,
    verdict: Option<&str>,
    sent: i64,
    depends: &str,
) {
    conn.execute(
        "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, sent, depends_on, queued_at)
             VALUES (?1, ?2, ?1, '{}', ?3, ?4, ?5, '2026-01-01T00:00:00Z')",
        params![id, kind, verdict, sent, depends],
    )
    .unwrap();
}

fn queue_ids(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT id FROM queue ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

fn named(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

#[test]
fn forgetting_named_rows_takes_only_those_and_keeps_every_other_answered_row() {
    let build = || {
        let conn = conn();
        queue_row(&conn, "read", "update_item", Some("accepted"), 1, "[]");
        queue_row(&conn, "later", "update_item", Some("merged"), 1, "[]");
        queue_row(&conn, "other", "update_item", Some("conflicted"), 1, "[]");
        conn
    };
    // The witness: an unrestricted clearing takes all three, so the rows
    // kept below were producible.
    let all = build();
    assert_eq!(forget_answered(&all).unwrap(), 3);

    let conn = build();
    assert_eq!(
        forget_answered_ids(&conn, &named(&["read", "other"])).unwrap(),
        2
    );
    assert_eq!(
        queue_ids(&conn),
        named(&["later"]),
        "a clearing of named writes took one nobody named, which an app has not yet read"
    );
}

#[test]
fn forgetting_named_rows_keeps_every_row_a_clearing_keeps() {
    let conn = conn();
    queue_row(&conn, "unanswered", "update_item", None, 0, "[]");
    queue_row(&conn, "sent", "update_item", None, 1, "[]");
    queue_row(&conn, "blocked", "update_item", Some("blocked"), 1, "[]");
    queue_row(&conn, "dead", "update_item", Some("dead"), 1, "[]");
    queue_row(&conn, "unsent", "delete_item", Some("refused"), 0, "[]");
    queue_row(&conn, "content", "update_item", Some("refused"), 1, "[]");
    let every = named(&["unanswered", "sent", "blocked", "dead", "unsent", "content"]);
    let before = queue_ids(&conn);
    assert_eq!(forget_answered_ids(&conn, &every).unwrap(), 0);
    assert_eq!(queue_ids(&conn), before);

    // The witness: the same kinds, answered and carrying nothing, go.
    queue_row(&conn, "refused", "delete_item", Some("refused"), 1, "[]");
    queue_row(&conn, "accepted", "update_item", Some("accepted"), 1, "[]");
    assert_eq!(
        forget_answered_ids(&conn, &named(&["refused", "accepted"])).unwrap(),
        2
    );
    assert_eq!(queue_ids(&conn), before);
}

#[test]
fn forgetting_named_rows_ignores_an_id_the_queue_does_not_hold() {
    let conn = conn();
    queue_row(&conn, "read", "update_item", Some("accepted"), 1, "[]");
    assert_eq!(forget_answered_ids(&conn, &[]).unwrap(), 0);
    assert_eq!(
        forget_answered_ids(&conn, &named(&["nowhere", "%", "rea"])).unwrap(),
        0,
        "an id that names nothing, or only part of one, took a row"
    );
    assert_eq!(queue_ids(&conn), named(&["read"]));
    assert_eq!(
        forget_answered_ids(&conn, &named(&["nowhere", "read", "read"])).unwrap(),
        1
    );
    assert!(queue_ids(&conn).is_empty());
}

#[test]
fn forgetting_a_named_row_keeps_it_while_a_row_that_may_still_be_sent_depends_on_it() {
    for waiting in [
        (None, 0),
        (Some("blocked"), 1),
        (Some("dead"), 1),
        (Some("refused"), 0),
    ] {
        let conn = conn();
        queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
        queue_row(
            &conn,
            "waiter",
            "update_item",
            waiting.0,
            waiting.1,
            "[\"named\"]",
        );
        assert_eq!(
            forget_answered_ids(&conn, &named(&["named"])).unwrap(),
            0,
            "a named row went while {waiting:?} waits on it, which then waits for a write no drain can find"
        );
        assert_eq!(queue_ids(&conn), named(&["named", "waiter"]));
    }
    // The witness: once the waiting row is answered, the dependency goes.
    let conn = conn();
    queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
    queue_row(
        &conn,
        "waiter",
        "update_item",
        Some("accepted"),
        1,
        "[\"named\"]",
    );
    assert_eq!(forget_answered_ids(&conn, &named(&["named"])).unwrap(), 1);
    assert_eq!(queue_ids(&conn), named(&["waiter"]));
}

#[test]
fn forgetting_named_rows_repeats_its_passes_inside_the_names() {
    let build = || {
        let conn = conn();
        queue_row(
            &conn,
            "dependency",
            "update_item",
            Some("accepted"),
            1,
            "[]",
        );
        // Refused unsent behind a write the queue no longer holds: it
        // goes, and then the row it kept can go.
        queue_row(
            &conn,
            "leftover",
            "delete_item",
            Some("refused"),
            0,
            "[\"dependency\", \"gone\"]",
        );
        conn
    };
    let all = build();
    assert_eq!(forget_answered(&all).unwrap(), 2);

    let conn = build();
    assert_eq!(
        forget_answered_ids(&conn, &named(&["dependency"])).unwrap(),
        0,
        "the dependency went while a leftover not named still depends on it"
    );
    assert_eq!(
        forget_answered_ids(&conn, &named(&["leftover"])).unwrap(),
        1
    );
    assert_eq!(queue_ids(&conn), named(&["dependency"]));

    let both = build();
    assert_eq!(
        forget_answered_ids(&both, &named(&["dependency", "leftover"])).unwrap(),
        2,
        "a pass that freed a named row did not repeat"
    );
    assert!(queue_ids(&both).is_empty());
}

#[test]
fn forgetting_named_rows_keeps_a_row_whose_receipt_is_pending() {
    let conn = conn();
    queue_row(&conn, "landing", "create_item", Some("accepted"), 1, "[]");
    meta_set(&conn, "receipt_pending/landing", "land:item").unwrap();
    assert_eq!(forget_answered_ids(&conn, &named(&["landing"])).unwrap(), 0);
    meta_delete(&conn, "receipt_pending/landing").unwrap();
    assert_eq!(forget_answered_ids(&conn, &named(&["landing"])).unwrap(), 1);
}

/// The SQLite virtual-machine steps `work` takes on `conn`.
fn steps_of(conn: &mut Connection, work: impl FnOnce(&Connection)) -> u64 {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    let steps = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&steps);
    let _ = conn.progress_handler(
        1,
        Some(move || {
            counted.fetch_add(1, Ordering::Relaxed);
            false
        }),
    );
    work(conn);
    let _ = conn.progress_handler(1, None::<fn() -> bool>);
    steps.load(Ordering::Relaxed)
}

/// The witness for the cost, the asserted answer for the meaning.
#[test]
fn the_untaken_creates_for_an_item_cost_the_same_however_many_landings_are_pending() {
    let mut conn = conn();
    let create = |id: &str, item: &str, verdict: Option<&str>| {
        conn.execute(
            "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, verdict, sent, depends_on, queued_at)
                 VALUES (?1, 'create_item', ?2, ?1, '{}', ?3, 1, '[]', '2026-01-01T00:00:00Z')",
            params![id, item, verdict],
        )
        .unwrap();
    };
    create("refused-onto-a-row", "item", Some("refused"));
    create("refused-and-unlanded", "other", Some("refused"));
    create("unanswered", "unanswered-item", None);
    meta_set(&conn, "receipt_pending/refused-onto-a-row", "land:landed").unwrap();
    let ask = |conn: &mut Connection, item: &str| {
        let mut found = Vec::new();
        let steps = steps_of(conn, |conn| {
            found = untaken_creates_for_item(conn, item).unwrap();
        });
        (found, steps)
    };
    let (few_found, few) = ask(&mut conn, "item");
    assert_eq!(few_found, named(&["refused-onto-a-row"]));
    assert_eq!(ask(&mut conn, "other").0, Vec::<String>::new());
    assert_eq!(ask(&mut conn, "unanswered-item").0, named(&["unanswered"]));

    for n in 0..2_000 {
        meta_set(
            &conn,
            &format!("receipt_pending/waiting-{n}"),
            &format!("land:row-{n}"),
        )
        .unwrap();
        meta_set(&conn, &format!("unrelated/{n}"), "x").unwrap();
    }
    let (many_found, many) = ask(&mut conn, "item");
    assert_eq!(many_found, few_found);
    assert!(
        many < few * 2 + 100,
        "a lookup took {many} steps beside 2001 pending landings and {few} beside one: \
             it reads every landing, so a folder's first sync pays for each edge by the \
             size of the store"
    );
}

#[test]
fn forgetting_named_rows_cleans_only_their_own_effect_slots() {
    let conn = conn();
    queue_row(&conn, "named", "update_item", Some("accepted"), 1, "[]");
    queue_row(&conn, "kept", "update_item", Some("accepted"), 1, "[]");
    for id in ["named", "kept", "orphan"] {
        meta_set(&conn, &format!("dead_effect/{id}"), "x").unwrap();
        meta_set(&conn, &format!("chosen_tier/{id}"), "library").unwrap();
        meta_set(&conn, &format!("sent_as/{id}"), "x").unwrap();
        meta_set(&conn, &format!("sent_source/{id}"), "x").unwrap();
        meta_set(&conn, &format!("cleared_time/{id}"), "1").unwrap();
    }
    assert_eq!(forget_answered_ids(&conn, &named(&["named"])).unwrap(), 1);
    for prefix in [
        "dead_effect/",
        "chosen_tier/",
        "sent_as/",
        "sent_source/",
        "cleared_time/",
    ] {
        assert!(
            meta_get(&conn, &format!("{prefix}named"))
                .unwrap()
                .is_none(),
            "{prefix} outlived the row it belongs to"
        );
        assert!(meta_get(&conn, &format!("{prefix}kept")).unwrap().is_some());
        assert!(
            meta_get(&conn, &format!("{prefix}orphan"))
                .unwrap()
                .is_some(),
            "{prefix} of a row nobody named was cleaned"
        );
    }
    // The witness: an unrestricted clearing cleans the orphan too.
    forget_answered(&conn).unwrap();
    assert!(meta_get(&conn, "dead_effect/orphan").unwrap().is_none());
}

#[test]
fn a_withdraw_refuses_the_chain_behind_it_and_clearing_takes_all_of_it() {
    let conn = conn();
    // Deletes, which carry nothing a clearing could lose.
    let row = |id: &str, verdict: Option<&str>, sent: i64, depends: &str| {
        conn.execute(
            "INSERT INTO queue (id, kind, idempotency_key, payload, verdict, reason, sent, depends_on, queued_at)
                 VALUES (?1, 'delete_item', ?1, '{}', ?2, ?3, ?4, ?5, '2026-01-01T00:00:00Z')",
            params![
                id,
                verdict,
                verdict.map(|_| "conflict_unresolved"),
                sent,
                depends
            ],
        )
        .unwrap();
    };
    row("stuck", Some("blocked"), 1, "[]");
    row("next", None, 0, "[\"stuck\"]");
    row("after-next", None, 0, "[\"next\"]");
    let ids = |rows: Vec<QueuedWrite>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
    let held = held_for(&conn, "stuck").unwrap();
    assert_eq!(
        ids(held.clone()),
        vec!["next".to_string(), "after-next".to_string()],
        "the write two steps behind is held for the withdrawn one too"
    );

    let stuck = queued_write(&conn, "stuck").unwrap().unwrap();
    withdraw(&conn, &stuck, &held).unwrap();
    assert!(
        !release(&conn, "after-next").unwrap(),
        "a write refused behind one refused for a withdrawn write was released, \
             to be refused again by the next drain"
    );
    row("ahead", Some("refused"), 1, "[]");
    row("behind", Some("refused"), 0, "[\"ahead\"]");
    assert!(release(&conn, "behind").unwrap());

    row("orphan", Some("refused"), 0, "[\"gone\"]");
    row("waiting-on-orphan", None, 0, "[\"orphan\"]");
    forget_answered(&conn).unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT id FROM queue ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(
        left,
        vec![
            "ahead".to_string(),
            "behind".to_string(),
            "orphan".to_string(),
            "waiting-on-orphan".to_string()
        ],
        "the refused chain should go whole, and a row an unanswered one names should stay"
    );
}
