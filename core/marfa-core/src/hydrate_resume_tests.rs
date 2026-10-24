//! A hydration that stopped before it finished carries on from the page it
//! had reached, or starts again from the first page and says why.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use crate::scripted::{self, Answer, Scripted, Then};
use crate::stop_tests::copy;
use crate::{Completeness, Core, CoreError, HydrateReport, HydrateRestart, SliceTier, store};

const WAIT: Duration = Duration::from_secs(5);

fn row(id: &str, version: i64) -> Value {
    let payload: Value = serde_json::from_str(&scripted::item_payload(
        "item.updated",
        id,
        "core.note",
        version,
    ))
    .unwrap();
    json!({"item": payload["item"], "metadata": payload["metadata"], "listed": true})
}

/// A page of the listing holding the notes named, naming the page after it
/// by `next`.
fn page(ids: &[&str], next: Option<&str>) -> Answer {
    let data: Vec<Value> = ids.iter().map(|id| row(id, 1)).collect();
    let body = json!({"data": data, "next_cursor": next});
    scripted::certified(scripted::json(200, &body.to_string()))
}

fn bulk(ids: &[&str]) -> Answer {
    let rows: Vec<Value> = ids.iter().map(|id| row(id, 1)).collect();
    let body = json!({
        "items": rows.iter().map(|row| row["item"].clone()).collect::<Vec<_>>(),
        "metadata": ids
            .iter()
            .map(|id| json!({"item_id": id, "tags": [], "extensions": {}}))
            .collect::<Vec<_>>(),
        "listed": ids.iter().map(|_| true).collect::<Vec<_>>(),
    });
    scripted::certified(scripted::json(200, &body.to_string()))
}

fn head(cursor: &str) -> Answer {
    scripted::stream(
        vec![scripted::copy_marker("stream_cursor", cursor)],
        Then::End,
    )
}

/// The stream a replay from the copy's head reads: the log's head at
/// `live`, `events`, then the end of the replay.
fn replay(events: Vec<String>, live: &str) -> Answer {
    let mut frames = vec![scripted::copy_marker("stream_cursor", live)];
    frames.extend(events);
    frames.push(scripted::copy_marker("stream_live", live));
    scripted::stream(frames, Then::End)
}

fn hydrate(core: &Core, tier: SliceTier) -> crate::Result<HydrateReport> {
    core.hydrate_until(&["core.note".into()], tier, &[], &AtomicBool::new(false))
}

fn point(core: &Core) -> Option<Value> {
    store::meta_get(&core.conn().unwrap(), store::META_HYDRATE_RESUME)
        .unwrap()
        .map(|point| serde_json::from_str(&point).unwrap())
}

fn held(core: &Core) -> Vec<String> {
    let mut ids: Vec<String> = core
        .list(&crate::ListFilters::default(), crate::Sort::default())
        .unwrap()
        .rows
        .into_iter()
        .map(|item| item.id)
        .collect();
    ids.sort();
    ids
}

/// A copy whose hydration took the listing's first two pages of three, and
/// failed asking for the third: holding a queued tag on `a` and a pin of
/// `pinned`, which the hydration had not reached.
fn interrupted(server: &Scripted) -> Arc<Core> {
    let core = copy(server);
    {
        let conn = core.conn().unwrap();
        store::replace_catalog(&conn, &crate::builtin::catalog().unwrap()).unwrap();
        store::put_server_item(
            &conn,
            &store::testing::note("a", "a", "body", "2026-01-01T00:00:00Z"),
            Some(&[]),
            &crate::catalog::Catalog::load(&conn).unwrap(),
        )
        .unwrap();
        store::pin(&conn, "pinned").unwrap();
    }
    core.add_tag("a", "kept").unwrap();
    server.on(
        "/items",
        vec![
            page(&["a"], Some("2")),
            page(&["b"], Some("3")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    server.on("/events", vec![head("10")]);
    assert!(matches!(
        hydrate(&core, SliceTier::Library),
        Err(CoreError::Server { .. })
    ));
    assert_eq!(server.seen("/items").len(), 3);
    assert_eq!(
        point(&core).unwrap(),
        json!({"phase": "items", "listing": "core.note", "cursor": "3", "pages": 2})
    );
    core
}

/// What a resumed hydration reads after the head and the probe: the third
/// page, the pinned row and a replay.
fn the_rest(server: &Scripted, events: Vec<String>, live: &str) {
    server.on("/items", vec![page(&["c"], None)]);
    server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
    server.on(
        "/events",
        vec![head(live), replay(vec![], live), replay(events, live)],
    );
}

#[test]
fn an_interrupted_hydration_reads_only_the_pages_it_had_not_reached() {
    let server = Scripted::start();
    let core = interrupted(&server);
    assert_eq!(
        core.list(&crate::ListFilters::default(), crate::Sort::default())
            .unwrap()
            .completeness,
        Completeness::Partial
    );
    let asked = server.seen("/items").len();
    the_rest(&server, vec![], "10");

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(report.resumed);
    assert_eq!(report.restarted, None);
    assert_eq!((report.pages, report.pages_total), (1, 3));
    let listings = server.seen("/items");
    assert_eq!(
        listings.len(),
        asked + 1,
        "a page already held was read again"
    );
    assert!(
        listings[asked].query.contains("cursor=3"),
        "{}",
        listings[asked].query
    );
    assert_eq!(held(&core), ["a", "b", "c", "pinned"]);
    assert_eq!(core.get("a").unwrap().unwrap().tags, ["kept"]);
    assert_eq!(point(&core), None);
    assert_eq!(
        store::meta_get(&core.conn().unwrap(), store::META_ITEMS_LISTED).unwrap(),
        None
    );
    assert_eq!(
        core.list(&crate::ListFilters::default(), crate::Sort::default())
            .unwrap()
            .completeness,
        Completeness::Complete
    );
}

#[test]
fn a_resumed_hydration_replays_what_changed_on_the_server_while_it_was_stopped() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let listed = |event: &str, id: &str| {
        let mut payload: Value =
            serde_json::from_str(&scripted::item_payload(event, id, "core.note", 2)).unwrap();
        payload["listed"] = true.into();
        if event == "item.deleted" {
            payload["item"]["state"] = "trashed".into();
        }
        payload.to_string()
    };
    let (updated, deleted) = (listed("item.updated", "a"), listed("item.deleted", "b"));
    the_rest(
        &server,
        vec![
            scripted::event("11", "item.updated", &updated),
            scripted::event("12", "item.deleted", &deleted),
        ],
        "12",
    );

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(report.resumed);
    assert_eq!(report.cursor, "12");
    assert_eq!(core.get("a").unwrap().unwrap().version, 2);
    assert_eq!(held(&core), ["a", "c", "pinned"]);
    assert!(
        core.get("b")
            .unwrap()
            .is_none_or(|b| b.state != crate::ItemState::Active),
        "the row deleted while the hydration was stopped is still active"
    );
}

/// `the_rest`, read from the first page: the whole listing in one.
fn from_the_start(server: &Scripted) {
    server.on("/items", vec![page(&["a", "b", "c"], None)]);
    server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
    server.on("/events", vec![head("10"), replay(vec![], "10")]);
}

fn started_again(server: &Scripted, report: &HydrateReport, asked: usize, reason: HydrateRestart) {
    assert!(!report.resumed);
    assert_eq!(report.restarted, Some(reason));
    assert_eq!((report.pages, report.pages_total), (1, 1));
    let listings = server.seen("/items");
    assert!(
        !listings.last().unwrap().query.contains("cursor="),
        "{}",
        listings.last().unwrap().query
    );
    assert_eq!(listings.len(), asked + 1);
}

#[test]
fn another_slice_starts_the_hydration_again() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let asked = server.seen("/items").len();
    from_the_start(&server);

    let report = hydrate(&core, SliceTier::All).unwrap();

    started_again(&server, &report, asked, HydrateRestart::SliceChanged);
    assert_eq!(held(&core), ["a", "b", "c", "pinned"]);
    assert_eq!(core.get("a").unwrap().unwrap().tags, ["kept"]);
}

#[test]
fn another_instance_or_reach_starts_the_hydration_again() {
    for (key, reason) in [
        (store::META_INSTANCE_ID, HydrateRestart::InstanceChanged),
        (crate::reach::FENCE, HydrateRestart::ReachChanged),
    ] {
        let server = Scripted::start();
        let core = interrupted(&server);
        // As kept by an interrupted hydration under another server or key:
        // the server's answers now name `scripted::INSTANCE` and its reach.
        store::meta_set(&core.conn().unwrap(), key, &"b".repeat(64)).unwrap();
        let asked = server.seen("/items").len();
        from_the_start(&server);

        let report = hydrate(&core, SliceTier::Library).unwrap();

        started_again(&server, &report, asked, reason);
        assert_eq!(held(&core), ["a", "b", "c", "pinned"], "{reason:?}");
    }
}

#[test]
fn a_changed_catalog_starts_the_hydration_again() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let asked = server.seen("/items").len();
    from_the_start(&server);
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[
            ("core.note", None),
            ("user.late", Some("core.note")),
        ]))],
    );
    // The probe is asked before the catalog is compared.
    server.on(
        "/events",
        vec![head("10"), replay(vec![], "10"), replay(vec![], "10")],
    );

    let report = hydrate(&core, SliceTier::Library).unwrap();

    started_again(&server, &report, asked, HydrateRestart::CatalogChanged);
    assert!(core.item_type("user.late").is_ok());
}

#[test]
fn a_head_the_log_no_longer_holds_starts_the_hydration_again() {
    let too_old = "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\",\"requested\":\"10\"}\n\n".to_string();
    for (probe, reason) in [
        (
            vec![scripted::copy_marker("stream_cursor", "60"), too_old],
            HydrateRestart::HeadAgedOut,
        ),
        (
            vec![scripted::copy_marker("stream_cursor", "5")],
            HydrateRestart::HeadPastLog,
        ),
    ] {
        let server = Scripted::start();
        let core = interrupted(&server);
        let asked = server.seen("/items").len();
        let live = if reason == HydrateRestart::HeadPastLog {
            "5"
        } else {
            "60"
        };
        server.on("/items", vec![page(&["a", "b", "c"], None)]);
        server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
        server.on(
            "/events",
            vec![
                head(live),
                scripted::stream(probe, Then::End),
                replay(vec![], live),
            ],
        );

        let report = hydrate(&core, SliceTier::Library).unwrap();

        started_again(&server, &report, asked, reason);
        assert_eq!(report.cursor, live);
        let replays = server.seen("/events");
        assert_eq!(
            replays.last().unwrap().last_event_id.as_deref(),
            Some(live),
            "the replay did not start from the head read now"
        );
        assert_eq!(held(&core), ["a", "b", "c", "pinned"], "{reason:?}");
    }
}

#[test]
fn a_refused_page_cursor_starts_the_hydration_again_once() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let asked = server.seen("/items").len();
    server.on(
        "/items",
        vec![
            scripted::refusal(400, "validation_error"),
            page(&["a", "b", "c"], None),
        ],
    );
    server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
    server.on(
        "/events",
        vec![
            head("10"),
            replay(vec![], "10"),
            head("10"),
            replay(vec![], "10"),
        ],
    );

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(!report.resumed);
    assert_eq!(report.restarted, Some(HydrateRestart::CursorRefused));
    let listings = server.seen("/items");
    assert_eq!(listings.len(), asked + 2);
    assert!(listings[asked].query.contains("cursor=3"));
    assert!(!listings[asked + 1].query.contains("cursor="));
    assert_eq!(held(&core), ["a", "b", "c", "pinned"]);
    assert_eq!(core.get("a").unwrap().unwrap().tags, ["kept"]);
}

#[test]
fn a_cursor_refused_from_the_first_page_is_not_resumed_again() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let asked = server.seen("/items").len();
    // The resumed cursor is refused, and so is the first page of the walk
    // that starts again: that refusal ends the call.
    server.on(
        "/items",
        vec![
            scripted::refusal(400, "validation_error"),
            page(&["a"], Some("2")),
            scripted::refusal(400, "validation_error"),
        ],
    );
    server.on(
        "/events",
        vec![head("10"), replay(vec![], "10"), head("10")],
    );

    assert!(matches!(
        hydrate(&core, SliceTier::Library),
        Err(CoreError::Validation { .. })
    ));
    assert_eq!(server.seen("/items").len(), asked + 3);
}

#[test]
fn a_hydration_stopped_once_its_last_page_is_in_resumes_with_no_page_to_read() {
    let server = Scripted::start();
    let core = interrupted(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/items",
        vec![Answer::WaitFor {
            ready: Arc::clone(&ready),
            answer: Box::new(page(&["c"], None)),
        }],
    );
    server.on("/items/bulk-get", vec![bulk(&["pinned"])]);
    server.on("/events", vec![head("10"), replay(vec![], "10")]);
    let stop = Arc::new(AtomicBool::new(false));
    let running = {
        let (core, stop) = (Arc::clone(&core), Arc::clone(&stop));
        std::thread::spawn(move || {
            core.hydrate_until(&["core.note".into()], SliceTier::Library, &[], &stop)
        })
    };
    server.wait_for("/items", 4, WAIT);
    stop.store(true, Ordering::SeqCst);
    ready.store(true, Ordering::SeqCst);
    assert!(matches!(running.join().unwrap(), Err(CoreError::Canceled)));
    assert_eq!(
        point(&core).unwrap(),
        json!({"phase": "pins", "listing": null, "cursor": null, "pages": 3})
    );
    assert_eq!(held(&core), ["a", "b", "c"]);
    let asked = server.seen("/items").len();
    the_rest(&server, vec![], "10");

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(report.resumed);
    assert_eq!((report.pages, report.pages_total), (0, 3));
    assert_eq!(server.seen("/items").len(), asked);
    assert_eq!(held(&core), ["a", "b", "c", "pinned"]);
}

#[test]
fn a_finished_hydration_leaves_nothing_to_resume() {
    let server = Scripted::start();
    let core = interrupted(&server);
    the_rest(&server, vec![], "10");
    assert!(hydrate(&core, SliceTier::Library).unwrap().resumed);
    let asked = server.seen("/items").len();
    from_the_start(&server);

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(!report.resumed);
    assert_eq!(report.restarted, None);
    assert_eq!(server.seen("/items").len(), asked + 1);
}

#[test]
fn an_expired_copy_leaves_nothing_to_resume() {
    let server = Scripted::start();
    let core = interrupted(&server);
    {
        let mut conn = core.conn().unwrap();
        let tx = conn.transaction().unwrap();
        crate::reach::expire(&tx).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(point(&core), None);
    from_the_start(&server);

    let report = hydrate(&core, SliceTier::Library).unwrap();

    assert!(!report.resumed);
    assert_eq!(report.restarted, None);
}
