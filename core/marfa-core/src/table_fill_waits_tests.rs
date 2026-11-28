//! A hydration, a catch-up or a follow that starts while a fill an app
//! started holds the stream waits for that fill rather than being refused
//! for it (`device/table-fill-waited-for`).

use std::fmt::Debug;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use marfa_rules::wire::{WireCatalog, WireType};
use serde_json::{Value, json};

use crate::catch_up::{Change, ChangeEvent, Pace};
use crate::scripted::{self, Answer, Scripted, Then};
use crate::watch::WatchListener;
use crate::{
    CatchUpFailed, CatchUpReport, Core, CoreError, FillReport, FollowReport, HydrateReport,
    Listening, Result, Server, SliceTier, TableHold, fault, store,
};

const NOTE: &str = "core.note";
pub(crate) const LEDGER: &str = "app.acme.ledger";
pub(crate) const STEPS: &str = "steps";
const NOTES: &str = "notes";
pub(crate) const CLAIMED: &str = "table-fill-claimed";
const ENDED: &str = "table-fill-ended";
pub(crate) const WAITING: &str = "stream-waiting-for-fill";
const FOLLOW_CLAIMING: &str = "follow-claiming";
pub(crate) const ROWS: &str = "/items/n1/tables/steps/rows";

/// Within one poll of a stop, with room for a slow machine.
const SOON: Duration = Duration::from_millis(500);
/// How long a call that waits is seen not to end.
const QUIET: Duration = Duration::from_millis(300);
pub(crate) const LONG: Duration = Duration::from_secs(10);

const QUICK: Pace = Pace {
    stop_poll: Duration::from_millis(10),
    silence: Duration::from_secs(60),
    reconnect_first: Duration::from_millis(10),
    reconnect_most: Duration::from_millis(40),
    synced_every: Duration::from_secs(30),
    read_only_every: Duration::from_secs(15 * 60),
    read_only_page: 1_000,
    clock: &Instant::now,
};

fn ledger() -> Value {
    json!({
        "id": LEDGER,
        "fields": {},
        "tables": {
            "steps": {"columns": {"a": {"type": "string"}}},
            "notes": {"columns": {"a": {"type": "string"}}},
        },
    })
}

fn types_answer() -> Answer {
    let body = json!({
        "data": [{"id": NOTE, "display_hints": {"title_field": "title"}}, ledger()],
        "next_cursor": null,
    });
    scripted::certified(scripted::json(200, &body.to_string()))
}

fn row(at: usize) -> Value {
    json!({
        "id": format!("019a5b1e-7c41-7d2e-9f3a-{at:012}"),
        "values": {"a": "x"},
        "updated_at": "2026-01-01T00:00:00Z",
    })
}

fn page(rows: std::ops::Range<usize>, next: Option<&str>) -> Answer {
    let body = json!({"data": rows.map(row).collect::<Vec<_>>(), "next_cursor": next});
    scripted::certified(scripted::json(200, &body.to_string()))
}

/// Adds to `catalog` a type declaring `steps` and `notes`, holds `n1` of it,
/// and answers its tables: `steps` in two pages, 1,000 rows and then 500.
pub(crate) fn hold_n1(server: &Scripted, core: &Core, mut catalog: WireCatalog) {
    {
        let conn = core.conn().unwrap();
        catalog
            .types
            .push(serde_json::from_value::<WireType>(ledger()).unwrap());
        store::replace_catalog(&conn, &catalog).unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        let item =
            store::testing::wire_item("n1", LEDGER, "active", "2026-01-01T00:00:00Z", json!({}));
        crate::reach::set_listed(&conn, "n1", true).unwrap();
        store::put_server_item(&conn, &item, Some(&[]), &catalog).unwrap();
    }
    let summary = json!({
        "data": [
            {"name": "steps", "row_count": 1500, "bytes": 30_000},
            {"name": "notes", "row_count": 2, "bytes": 40},
        ],
        "next_cursor": null,
    });
    server.on(
        "/items/n1/tables",
        vec![scripted::certified(scripted::json(
            200,
            &summary.to_string(),
        ))],
    );
    server.on(
        ROWS,
        vec![page(0..1000, Some("p2")), page(1000..1500, None)],
    );
    server.on("/items/n1/tables/notes/rows", vec![page(0..2, None)]);
}

fn created(id: &str, cursor: &str) -> String {
    let mut payload: Value =
        serde_json::from_str(&scripted::item_payload("item.created", id, NOTE, 1)).unwrap();
    payload["listed"] = true.into();
    scripted::event(cursor, "item.created", &payload.to_string())
}

/// A stream from `from` with `events` as `(id, cursor)`, going live at the
/// last of them.
pub(crate) fn events(from: &str, events: &[(&str, &str)], then: Then) -> Answer {
    let mut frames = vec![scripted::copy_marker("stream_cursor", from)];
    frames.extend(events.iter().map(|(id, cursor)| created(id, cursor)));
    let live = events.last().map_or(from, |(_, cursor)| cursor);
    frames.push(scripted::copy_marker("stream_live", live));
    scripted::stream(frames, then)
}

fn held() -> Then {
    Then::Hold {
        keepalive: Some(Duration::from_millis(5)),
        lasting: None,
    }
}

/// Answered only once `ready` is raised.
pub(crate) fn until(ready: &Arc<AtomicBool>, answer: Answer) -> Answer {
    Answer::WaitFor {
        ready: Arc::clone(ready),
        answer: Box::new(answer),
    }
}

fn slice() -> Vec<String> {
    vec![NOTE.into(), LEDGER.into()]
}

pub(crate) struct Copy {
    _dir: tempfile::TempDir,
    path: PathBuf,
    pub(crate) server: Scripted,
    pub(crate) core: Arc<Core>,
    /// Raised to let the follow's stream send its event.
    pub(crate) go: Arc<AtomicBool>,
}

fn open(path: &Path, server: &Scripted) -> Core {
    Core::open(
        path,
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap()
}

/// A whole copy at cursor 10 holding `n1`, whose stream sends one event
/// once `go` is raised.
pub(crate) fn copy() -> Copy {
    fault::observe(true);
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = open(&path, &server);
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::reach::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(
            &conn,
            store::META_SLICE_TYPES,
            &serde_json::to_string(&slice()).unwrap(),
        )
        .unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        store::mark_read_only_read(&conn).unwrap();
    }
    hold_n1(
        &server,
        &core,
        WireCatalog {
            types: vec![store::testing::wire_type(NOTE, None, Some("title"))],
            edge_types: Vec::new(),
        },
    );
    server.on("/types", vec![types_answer()]);
    server.on(
        "/edge-types",
        vec![scripted::certified(scripted::edge_types(&[]))],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read","app.acme.ledger":"read"}}"#,
        ))],
    );
    let go = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![until(&go, events("11", &[("e1", "11")], held()))],
    );
    core.watch.set_follow_pace(QUICK);
    Copy {
        _dir: dir,
        path,
        server,
        core: Arc::new(core),
        go,
    }
}

fn on_thread<T: Send + 'static>(call: impl FnOnce() -> T + Send + 'static) -> Receiver<T> {
    let (sent, got) = mpsc::channel();
    thread::spawn(move || {
        let _ = sent.send(call());
    });
    got
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + LONG;
    while !done() {
        assert!(Instant::now() < until, "{what}");
        thread::sleep(Duration::from_millis(5));
    }
}

pub(crate) fn held_at(point: &str) {
    wait_until(&format!("nothing came to {point}"), || {
        fault::waiting(point) >= 1
    });
}

/// Waits for a call to find the fill holding the stream, failing with how
/// the call ended where it ended first.
fn waits_for_fill<T: Debug>(call: &Receiver<T>, before: usize) {
    let until = Instant::now() + LONG;
    while fault::reached(WAITING) <= before {
        if let Ok(ended) = call.try_recv() {
            panic!("the call ended rather than wait for the fill: {ended:?}");
        }
        assert!(Instant::now() < until, "the call never came to wait");
        thread::sleep(Duration::from_millis(5));
    }
}

fn still_running<T: Debug>(call: &Receiver<T>, what: &str) {
    if let Ok(ended) = call.recv_timeout(QUIET) {
        panic!("{what} ended while the fill held the stream: {ended:?}");
    }
}

fn hold(core: &Arc<Core>, table: &'static str) -> Receiver<Result<TableHold>> {
    let core = Arc::clone(core);
    on_thread(move || core.hold_table(LEDGER, table))
}

/// A hold of `steps` whose fill holds the stream until `CLAIMED` is released.
fn held_hold(core: &Arc<Core>) -> Receiver<Result<TableHold>> {
    fault::arm(CLAIMED);
    let held = hold(core, STEPS);
    held_at(CLAIMED);
    held
}

fn filled(hold: &Receiver<Result<TableHold>>) -> FillReport {
    hold.recv_timeout(LONG)
        .expect("the hold never ended")
        .expect("the hold failed")
        .fill
        .expect("the hold left its table to another call")
}

pub(crate) fn state(core: &Core, table: &str) -> Option<String> {
    crate::tables::state(&core.conn().unwrap(), "n1", table).unwrap()
}

pub(crate) fn cursor(core: &Core) -> Option<String> {
    store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap()
}

/// The cursor, the slice and the hydration state.
fn standing(core: &Core) -> (Option<String>, Option<String>, crate::Hydration) {
    let slice = store::meta_get(&core.conn().unwrap(), store::META_SLICE_TYPES).unwrap();
    (cursor(core), slice, core.status().unwrap().hydration)
}

type Told = Arc<Mutex<Vec<Change>>>;

fn kinds(told: &Told) -> Vec<String> {
    told.lock()
        .unwrap()
        .iter()
        .map(|change| change.event.as_str().to_string())
        .collect()
}

fn count(told: &Told, kind: &str) -> usize {
    kinds(told).iter().filter(|said| *said == kind).count()
}

struct Following {
    stop: Arc<AtomicBool>,
    told: Told,
    ended: Receiver<Result<FollowReport>>,
}

fn follow(core: &Arc<Core>) -> Following {
    following(core, false)
}

fn following(core: &Arc<Core>, observed: bool) -> Following {
    let stop = Arc::new(AtomicBool::new(false));
    let told = Told::default();
    let (core, flag, into) = (Arc::clone(core), Arc::clone(&stop), Arc::clone(&told));
    let ended = on_thread(move || {
        let tell = |change: &Change| into.lock().unwrap().push(change.clone());
        if observed {
            core.follow_observed(&flag, false, tell, |_| {})
        } else {
            core.follow(&flag, false, tell)
        }
    });
    Following { stop, told, ended }
}

fn catch_up(
    core: &Arc<Core>,
) -> (
    Arc<AtomicBool>,
    Receiver<std::result::Result<CatchUpReport, CatchUpFailed>>,
) {
    let stop = Arc::new(AtomicBool::new(false));
    let (core, flag) = (Arc::clone(core), Arc::clone(&stop));
    (stop, on_thread(move || core.catch_up_until(&flag)))
}

fn hydrate(core: &Arc<Core>, in_place: bool) -> (Arc<AtomicBool>, Receiver<Result<HydrateReport>>) {
    let stop = Arc::new(AtomicBool::new(false));
    let (core, flag) = (Arc::clone(core), Arc::clone(&stop));
    let ended = on_thread(move || {
        if in_place {
            core.hydrate_in_place_only(&slice(), SliceTier::Library, &[], &flag)
        } else {
            core.hydrate_until(&slice(), SliceTier::Library, &[], &flag)
        }
    });
    (stop, ended)
}

type Holding = (Arc<Core>, Sender<Result<TableHold>>);

/// What a watch's listener was told.
#[derive(Default)]
struct Heard {
    told: Told,
    ended: Mutex<Vec<Option<CoreError>>>,
    /// Holds `steps` from inside `changed` at the first event, answering here.
    holds: Mutex<Option<Holding>>,
    holding: AtomicBool,
}

impl WatchListener for Heard {
    fn changed(&self, change: &Change) {
        self.told.lock().unwrap().push(change.clone());
        if change.event.as_str() == "item.created"
            && let Some((core, answer)) = self.holds.lock().unwrap().take()
        {
            self.holding.store(true, Ordering::SeqCst);
            let _ = answer.send(core.hold_table(LEDGER, STEPS));
        }
    }

    fn ended(&self, error: Option<CoreError>) {
        self.ended.lock().unwrap().push(error);
    }
}

fn watch(core: &Arc<Core>, heard: &Arc<Heard>) -> Listening {
    core.watch(false, Arc::clone(heard) as Arc<dyn WatchListener>)
        .unwrap()
}

fn failed(heard: &Heard) -> usize {
    count(&heard.told, "watch.failed")
}

/// Waits for the watch's follow to find the fill holding the stream, failing
/// where the watch was told it failed first.
fn source_waits(heard: &Heard, before: usize) {
    wait_until("the watch's follow never came to wait", || {
        assert_eq!(
            failed(heard),
            0,
            "the watch failed rather than wait for the fill: {:?}",
            heard.told.lock().unwrap().last()
        );
        fault::reached(WAITING) > before
    });
}

fn invalid_already<T: Debug>(ended: &Result<T>) -> bool {
    matches!(ended, Err(CoreError::Invalid(said)) if said.contains("already"))
}

#[test]
fn a_follow_that_starts_while_a_hold_fills_waits_and_then_follows() {
    let copy = copy();
    let held = held_hold(&copy.core);
    let follow = follow(&copy.core);
    waits_for_fill(&follow.ended, 0);
    still_running(&follow.ended, "the follow");
    assert!(copy.server.seen("/events").is_empty());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    copy.server.wait_for("/events", 1, LONG);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the follow never told the event", || {
        count(&follow.told, "item.created") == 1
    });
    follow.stop.store(true, Ordering::SeqCst);
    let report = follow.ended.recv_timeout(LONG).unwrap().unwrap();
    assert_eq!(report.tables_failed, 0);
    assert_eq!(report.last_failure, None);
}

/// The watch's follow, stopped for a catch-up, starts again while a hold or
/// `fill_tables` fills.
fn restarted_while_filling(fills: impl FnOnce(&Arc<Core>) -> Receiver<Result<FillReport>>) {
    let copy = copy();
    copy.server.on(
        "/events",
        vec![
            events("10", &[], held()),
            events("10", &[], Then::End),
            until(&copy.go, events("11", &[("e1", "11")], held())),
        ],
    );
    let heard = Arc::new(Heard::default());
    let _listening = watch(&copy.core, &heard);
    copy.server.wait_for("/events", 1, LONG);
    fault::arm(FOLLOW_CLAIMING);
    copy.core.catch_up().unwrap();
    held_at(FOLLOW_CLAIMING);
    fault::arm(CLAIMED);
    let filling = fills(&copy.core);
    held_at(CLAIMED);
    fault::release(FOLLOW_CLAIMING);
    source_waits(&heard, 0);
    thread::sleep(QUIET);
    assert_eq!(failed(&heard), 0);
    fault::release(CLAIMED);
    assert_eq!(filling.recv_timeout(LONG).unwrap().unwrap().whole, 1);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the watch never told the event", || {
        count(&heard.told, "item.created") == 1
    });
    assert_eq!(failed(&heard), 0);
}

#[test]
fn a_watch_whose_follow_restarts_while_a_hold_fills_keeps_following() {
    restarted_while_filling(|core| {
        let core = Arc::clone(core);
        on_thread(move || {
            core.hold_table(LEDGER, STEPS)
                .map(|hold| hold.fill.expect("the hold left its table"))
        })
    });
}

#[test]
fn a_fill_tables_run_while_the_watch_restarts_leaves_the_follow_following() {
    restarted_while_filling(|core| {
        crate::tables::choose(&mut core.conn().unwrap(), LEDGER, STEPS).unwrap();
        let core = Arc::clone(core);
        on_thread(move || core.fill_tables(&AtomicBool::new(false)))
    });
}

#[test]
fn a_watch_that_starts_while_a_hold_fills_keeps_following() {
    let copy = copy();
    let held = held_hold(&copy.core);
    let heard = Arc::new(Heard::default());
    let _listening = watch(&copy.core, &heard);
    source_waits(&heard, 0);
    thread::sleep(QUIET);
    assert_eq!(failed(&heard), 0);
    assert!(copy.server.seen("/events").is_empty());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the watch never told the event", || {
        count(&heard.told, "item.created") == 1
    });
    assert_eq!(failed(&heard), 0);
}

#[test]
fn a_catch_up_that_starts_while_a_hold_fills_waits_and_then_catches_up() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    let held = held_hold(&copy.core);
    let (_stop, caught_up) = catch_up(&copy.core);
    waits_for_fill(&caught_up, 0);
    still_running(&caught_up, "the catch-up");
    assert!(copy.server.seen("/events").is_empty());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    let report = caught_up.recv_timeout(LONG).unwrap().unwrap();
    assert_eq!(report.applied, 1);
    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("whole"));
    let rows: i64 = copy
        .core
        .conn()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM table_rows WHERE item_id = 'n1' AND name = 'steps'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1500);
}

const TOO_OLD: &str = "event: catchup_too_old\ndata: {\"event_type\":\"catchup_too_old\",\"min_retained_id\":\"50\",\"requested\":\"10\"}\n\n";

fn no_rows() -> Answer {
    scripted::certified(scripted::json(
        200,
        &json!({"data": [], "next_cursor": null}).to_string(),
    ))
}

/// The head read and the replay a hydration asks for, at `cursor`.
fn hydration_events(cursor: &str) -> Vec<Answer> {
    let marker = |kind| scripted::copy_marker(kind, cursor);
    vec![
        scripted::stream(vec![marker("stream_cursor")], Then::End),
        scripted::stream(
            vec![marker("stream_cursor"), marker("stream_live")],
            Then::End,
        ),
    ]
}

#[test]
fn a_hydration_that_starts_while_a_hold_fills_waits_and_then_hydrates() {
    for in_place in [false, true] {
        let copy = copy();
        let at = if in_place {
            copy.server.on(
                "/events",
                vec![scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "60"), TOO_OLD.into()],
                    Then::End,
                )],
            );
            assert!(matches!(
                copy.core.catch_up(),
                Err(CoreError::CopyExpired { .. })
            ));
            assert_eq!(
                copy.core.status().unwrap().hydration,
                crate::Hydration::Stale
            );
            "60"
        } else {
            "10"
        };
        copy.server.on("/items", vec![no_rows()]);
        copy.server.on("/events", hydration_events(at));
        let held = held_hold(&copy.core);
        let (_stop, hydrated) = hydrate(&copy.core, in_place);
        waits_for_fill(&hydrated, 0);
        still_running(&hydrated, "the hydration");
        assert!(copy.server.seen("/events").len() <= usize::from(in_place));
        fault::release(CLAIMED);
        let hold = held.recv_timeout(LONG).unwrap();
        // A stale copy refuses the fill once it has held the stream.
        let refused = in_place && hold == Err(CoreError::HydrationIncomplete);
        assert!(hold.is_ok() || refused, "in place {in_place}: {hold:?}");
        let report = hydrated.recv_timeout(LONG).unwrap();
        assert!(report.is_ok(), "in place {in_place}: {report:?}");
        assert_eq!(report.unwrap().in_place, in_place);
    }
}

#[test]
fn a_folder_follow_that_starts_while_a_fill_runs_waits_and_then_follows() {
    let copy = copy();
    let held = held_hold(&copy.core);
    let follow = following(&copy.core, true);
    waits_for_fill(&follow.ended, 0);
    still_running(&follow.ended, "the folder's follow");
    assert!(copy.server.seen("/events").is_empty());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    copy.server.wait_for("/events", 1, LONG);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the folder's follow never told the event", || {
        count(&follow.told, "item.created") == 1
    });
    follow.stop.store(true, Ordering::SeqCst);
    follow.ended.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn a_catch_up_or_hydration_stopped_while_it_waits_for_a_fill_ends_canceled_having_asked_nothing() {
    for hydration in [false, true] {
        let copy = copy();
        let before = standing(&copy.core);
        let held = held_hold(&copy.core);
        let started = Instant::now();
        let ended: Receiver<Result<()>> = if hydration {
            let (stop, hydrated) = hydrate(&copy.core, false);
            waits_for_fill(&hydrated, 0);
            stop.store(true, Ordering::SeqCst);
            let ended = hydrated.recv_timeout(SOON).map(|ended| ended.map(drop));
            on_thread(move || ended.expect("the stopped hydration did not end"))
        } else {
            let (stop, caught_up) = catch_up(&copy.core);
            waits_for_fill(&caught_up, 0);
            stop.store(true, Ordering::SeqCst);
            let ended = caught_up
                .recv_timeout(SOON)
                .expect("the stopped catch-up did not end");
            let failed = ended.as_ref().err().map(|failed| failed.catalog_changed);
            assert_eq!(failed, Some(false), "{ended:?}");
            on_thread(move || ended.map(drop).map_err(|failed| failed.error))
        };
        let ended = ended.recv().unwrap();
        assert_eq!(ended, Err(CoreError::Canceled), "hydration {hydration}");
        assert!(started.elapsed() < LONG);
        let after = standing(&copy.core);
        assert_eq!(after, before, "hydration {hydration}");
        assert!(copy.server.seen("/types").is_empty());
        assert!(copy.server.seen("/events").is_empty());
        fault::release(CLAIMED);
        assert_eq!(filled(&held).whole, 1);
        assert_eq!(state(&copy.core, STEPS).as_deref(), Some("whole"));
    }
}

#[test]
fn a_catch_up_stopped_while_a_fills_page_read_is_in_flight_ends_within_one_poll() {
    let copy = copy();
    let page_go = Arc::new(AtomicBool::new(false));
    copy.server.on(
        ROWS,
        vec![
            page(0..1000, Some("p2")),
            until(&page_go, page(1000..1500, None)),
        ],
    );
    let held = hold(&copy.core, STEPS);
    copy.server.wait_for(ROWS, 2, LONG);
    let (stop, caught_up) = catch_up(&copy.core);
    waits_for_fill(&caught_up, 0);
    stop.store(true, Ordering::SeqCst);
    let ended = caught_up
        .recv_timeout(SOON)
        .expect("the stopped catch-up waited on the fill's page");
    assert_eq!(
        ended.map_err(|failed| failed.error),
        Err(CoreError::Canceled)
    );
    assert!(held.try_recv().is_err(), "the page was answered already");
    page_go.store(true, Ordering::SeqCst);
    assert_eq!(filled(&held).whole, 1);
}

#[test]
fn a_follow_stopped_while_it_waits_for_a_fill_ends_with_an_empty_report() {
    for observed in [false, true] {
        let copy = copy();
        let held = held_hold(&copy.core);
        let follow = following(&copy.core, observed);
        waits_for_fill(&follow.ended, 0);
        follow.stop.store(true, Ordering::SeqCst);
        let ended = follow
            .ended
            .recv_timeout(SOON)
            .expect("the stopped follow did not end");
        assert_eq!(ended, Ok(FollowReport::default()), "observed {observed}");
        assert!(copy.server.seen("/events").is_empty());
        fault::release(CLAIMED);
        assert_eq!(filled(&held).whole, 1);
    }
}

#[test]
fn of_two_calls_waiting_for_a_fill_one_takes_the_stream_and_the_other_is_refused() {
    let copy = copy();
    // The winner holds the stream for a second, so the other cannot wake
    // after it has finished.
    copy.server.on(
        "/events",
        vec![Answer::Slow {
            after: Duration::from_secs(1),
            answer: Box::new(events("11", &[("e1", "11")], held())),
        }],
    );
    let held = held_hold(&copy.core);
    let follow = follow(&copy.core);
    waits_for_fill(&follow.ended, 0);
    let (_stop, caught_up) = catch_up(&copy.core);
    waits_for_fill(&caught_up, 1);
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    let caught_up = caught_up
        .recv_timeout(LONG)
        .unwrap()
        .map_err(|failed| failed.error);
    if caught_up.is_ok() {
        let followed = follow.ended.recv_timeout(LONG).unwrap();
        assert!(invalid_already(&followed), "{followed:?}");
    } else {
        assert!(invalid_already(&caught_up), "{caught_up:?}");
        wait_until("the follow that won never told the event", || {
            count(&follow.told, "item.created") == 1
        });
        follow.stop.store(true, Ordering::SeqCst);
        follow.ended.recv_timeout(LONG).unwrap().unwrap();
    }
}

/// Raised to let a follow's stream, already live, send a sentinel event.
fn live_then_sentinel(copy: &Copy) {
    copy.server.on(
        "/events",
        vec![scripted::stream(
            vec![
                scripted::copy_marker("stream_cursor", "10"),
                scripted::copy_marker("stream_live", "10"),
            ],
            Then::WaitFor {
                entered: Arc::new(AtomicBool::new(false)),
                ready: Arc::clone(&copy.go),
                then: Box::new(Then::Later {
                    keepalive: Duration::from_millis(5),
                    after: Duration::ZERO,
                    frames: vec![created("sentinel", "11")],
                }),
            },
        )],
    );
}

fn filled_told(told: &Told) -> Vec<String> {
    told.lock()
        .unwrap()
        .iter()
        .filter_map(|change| match &change.event {
            ChangeEvent::TableFilled(table) => Some(table.clone()),
            _ => None,
        })
        .collect()
}

/// Lets the follow's stream send its sentinel and waits for it, so what the
/// follow tells before is all told.
fn through_sentinel(copy: &Copy, follow: &Following) {
    copy.server.wait_for("/events", 1, LONG);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the follow never told the sentinel", || {
        count(&follow.told, "item.created") == 1
    });
}

#[test]
fn a_hold_made_before_a_fill_starts_its_loop_is_filled_by_that_fill() {
    let copy = copy();
    live_then_sentinel(&copy);
    let held = held_hold(&copy.core);
    let follow = follow(&copy.core);
    waits_for_fill(&follow.ended, 0);
    let second = hold(&copy.core, NOTES).recv_timeout(LONG).unwrap().unwrap();
    assert!(second.fill.is_none());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 2);
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("whole"));
    assert_eq!(state(&copy.core, NOTES).as_deref(), Some("whole"));
    through_sentinel(&copy, &follow);
    assert_eq!(filled_told(&follow.told), Vec::<String>::new());
    follow.stop.store(true, Ordering::SeqCst);
    follow.ended.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn a_hold_made_after_a_fills_last_step_is_filled_by_the_follow_that_waited() {
    let copy = copy();
    live_then_sentinel(&copy);
    fault::arm(ENDED);
    let held = hold(&copy.core, STEPS);
    held_at(ENDED);
    let follow = follow(&copy.core);
    waits_for_fill(&follow.ended, 0);
    let second = hold(&copy.core, NOTES).recv_timeout(LONG).unwrap().unwrap();
    assert!(second.fill.is_none());
    fault::release(ENDED);
    assert_eq!(filled(&held).whole, 1);
    wait_until("the follow never told the table filled", || {
        !filled_told(&follow.told).is_empty()
    });
    through_sentinel(&copy, &follow);
    assert_eq!(filled_told(&follow.told), vec![NOTES.to_string()]);
    assert_eq!(state(&copy.core, NOTES).as_deref(), Some("whole"));
    follow.stop.store(true, Ordering::SeqCst);
    follow.ended.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn a_catch_up_takes_the_watch_from_a_follow_waiting_for_a_fill_within_one_poll() {
    // The witness first: a follow held where it waits, so it cannot look at
    // its stop, keeps the catch-up from the stream past the bound.
    for witness in [true, false] {
        let copy = copy();
        copy.server.on(
            "/events",
            vec![
                events("11", &[("e1", "11")], Then::End),
                events("12", &[("e2", "12")], held()),
            ],
        );
        let held = held_hold(&copy.core);
        let heard = Arc::new(Heard::default());
        let reached = fault::reached(WAITING);
        if witness {
            fault::arm(WAITING);
        }
        let _listening = watch(&copy.core, &heard);
        source_waits(&heard, reached);
        if witness {
            held_at(WAITING);
        }
        let (_stop, caught_up) = catch_up(&copy.core);
        let started = Instant::now();
        let took = loop {
            if fault::reached(WAITING) > reached + 1 {
                break true;
            }
            if started.elapsed() > SOON {
                break false;
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(
            took, !witness,
            "witness {witness}: the catch-up came to wait for the fill: {took}"
        );
        fault::release(WAITING);
        fault::release(CLAIMED);
        assert_eq!(filled(&held).whole, 1);
        assert_eq!(caught_up.recv_timeout(LONG).unwrap().unwrap().applied, 1);
        wait_until("the watch never told the event after the catch-up", || {
            heard
                .told
                .lock()
                .unwrap()
                .iter()
                .any(|change| change.item_id.as_deref() == Some("e2"))
        });
        assert_eq!(failed(&heard), 0);
    }
}

#[test]
fn a_watch_whose_listeners_leave_while_its_follow_waits_for_a_fill_ends_quietly() {
    let copy = copy();
    let held = held_hold(&copy.core);
    let heard = Arc::new(Heard::default());
    let listening = watch(&copy.core, &heard);
    source_waits(&heard, 0);
    listening.stop();
    let started = Instant::now();
    wait_until("the listener was never told it ended", || {
        !heard.ended.lock().unwrap().is_empty()
    });
    wait_until("the watch's follow did not end", || {
        copy.core.claim_follow().is_ok()
    });
    assert!(started.elapsed() < SOON, "{:?}", started.elapsed());
    assert_eq!(*heard.ended.lock().unwrap(), vec![None]);
    assert_eq!(failed(&heard), 0);
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
}

#[test]
fn a_fill_stopped_failed_or_panicking_lets_the_waiting_follow_take_the_stream() {
    for case in ["stopped", "failed", "panicking"] {
        let copy = copy();
        if case == "failed" {
            copy.server
                .on(ROWS, vec![scripted::refusal(503, "unavailable")]);
        }
        let stop = Arc::new(AtomicBool::new(false));
        fault::arm(CLAIMED);
        let held = {
            let (core, flag) = (Arc::clone(&copy.core), Arc::clone(&stop));
            let panics = case == "panicking";
            on_thread(move || {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _failing = panics.then(|| fault::fail_on_this_thread("table-fill-panics"));
                    core.hold_table_until(LEDGER, STEPS, &flag)
                }))
            })
        };
        held_at(CLAIMED);
        let follow = follow(&copy.core);
        waits_for_fill(&follow.ended, 0);
        if case == "stopped" {
            stop.store(true, Ordering::SeqCst);
        }
        fault::release(CLAIMED);
        let ended = held.recv_timeout(LONG).unwrap();
        let released = Instant::now();
        match case {
            "stopped" => assert!(matches!(ended, Ok(Err(CoreError::Canceled))), "{ended:?}"),
            "failed" => {
                let fill = ended.unwrap().unwrap().fill.unwrap();
                assert_eq!((fill.whole, fill.failed), (0, 1));
            }
            _ => assert!(ended.is_err(), "the fill did not panic"),
        }
        copy.server.wait_for("/events", 1, LONG);
        assert!(
            released.elapsed() < SOON,
            "{case}: {:?}",
            released.elapsed()
        );
        follow.stop.store(true, Ordering::SeqCst);
        follow.ended.recv_timeout(LONG).unwrap().unwrap();
    }
}

#[test]
fn a_listener_that_holds_a_table_while_a_catch_up_runs_deadlocks_nothing() {
    let copy = copy();
    let another_contract = Answer::Json {
        status: 200,
        body: "{}".into(),
        headers: vec![(
            crate::http::CONTRACT_HEADER.into(),
            (crate::contract::CONTRACT_VERSION + 1).to_string(),
        )],
    };
    // The source takes `e1` and then fails, letting the stream go; the
    // catch-up reads to the head; the source restarted after it holds on.
    copy.server.on(
        "/events",
        vec![
            until(&copy.go, events("11", &[("e1", "11")], Then::End)),
            another_contract,
            events("11", &[], Then::End),
            events("11", &[], held()),
        ],
    );
    let heard = Arc::new(Heard::default());
    let (answer, holds) = mpsc::channel();
    *heard.holds.lock().unwrap() = Some((Arc::clone(&copy.core), answer));
    let _listening = watch(&copy.core, &heard);
    copy.server.wait_for("/events", 1, LONG);
    // The dispatcher tells `e1` only once the source has ended, so the
    // listener's hold finds the stream free.
    copy.core.watch.held_up.store(true, Ordering::SeqCst);
    copy.go.store(true, Ordering::SeqCst);
    wait_until("the watch's follow never ended", || {
        copy.core.claim_follow().is_ok()
    });
    fault::arm(CLAIMED);
    copy.core.watch.held_up.store(false, Ordering::SeqCst);
    held_at(CLAIMED);
    assert!(heard.holding.load(Ordering::SeqCst));
    let before = fault::reached(WAITING);
    let (_stop, caught_up) = catch_up(&copy.core);
    waits_for_fill(&caught_up, before);
    fault::release(CLAIMED);
    let fill = filled(&holds);
    assert_eq!((fill.whole, fill.failed), (1, 0));
    caught_up
        .recv_timeout(LONG)
        .expect("the catch-up never ended")
        .unwrap();
    copy.server.wait_for("/events", 4, LONG);
    // The witness: a fill that never ends holds a catch-up past the bound.
    let copy = self::copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    let held = held_hold(&copy.core);
    let (_stop, caught_up) = catch_up(&copy.core);
    assert!(caught_up.recv_timeout(LONG).is_err());
    fault::release(CLAIMED);
    held.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn a_follow_waiting_for_a_fill_ends_copy_expired_or_waits_for_a_refill_as_the_copy_says() {
    for expires in [true, false] {
        let copy = copy();
        let held = held_hold(&copy.core);
        let follow = follow(&copy.core);
        waits_for_fill(&follow.ended, 0);
        if expires {
            crate::reach::expire(&copy.core.conn().unwrap()).unwrap();
            let ended = follow
                .ended
                .recv_timeout(SOON)
                .expect("the follow of an expired copy did not end");
            assert!(
                matches!(ended, Err(CoreError::CopyExpired { .. })),
                "{ended:?}"
            );
            fault::release(CLAIMED);
            let _ = held.recv_timeout(LONG).unwrap();
        } else {
            store::meta_set(
                &copy.core.conn().unwrap(),
                store::META_HYDRATE_STATE,
                store::HYDRATE_IN_PROGRESS,
            )
            .unwrap();
            still_running(&follow.ended, "the follow waiting for a refill");
            store::meta_delete(&copy.core.conn().unwrap(), store::META_HYDRATE_STATE).unwrap();
            still_running(&follow.ended, "the follow waiting for the fill");
            assert!(copy.server.seen("/events").is_empty());
            fault::release(CLAIMED);
            assert_eq!(filled(&held).whole, 1);
            copy.server.wait_for("/events", 1, LONG);
            follow.stop.store(true, Ordering::SeqCst);
            follow.ended.recv_timeout(LONG).unwrap().unwrap();
        }
    }
}

#[test]
fn a_row_write_waiting_for_the_head_behind_a_fill_is_late_after_its_wait() {
    let copy = copy();
    copy.server.on(
        "/events",
        vec![events("12", &[("e1", "11"), ("e2", "12")], Then::End)],
    );
    let held = held_hold(&copy.core);
    let started = Instant::now();
    let late = copy
        .core
        .caught_up_to_head(crate::streams::CAUGHT_UP_WAIT, &AtomicBool::new(false))
        .unwrap();
    let took = started.elapsed();
    assert!(
        late.as_ref().is_some_and(|said| said.contains("within")),
        "{late:?}"
    );
    assert!(
        took >= crate::streams::CAUGHT_UP_WAIT
            && took < crate::streams::CAUGHT_UP_WAIT + Duration::from_millis(100),
        "{took:?}"
    );
    assert_eq!(
        copy.server.seen("/events").len(),
        1,
        "only the head was read"
    );
    fault::release(CLAIMED);
    held.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn fill_tables_while_a_fill_holds_the_stream_is_refused_naming_a_table_fill() {
    let copy = copy();
    let held = held_hold(&copy.core);
    match copy.core.fill_tables(&AtomicBool::new(false)) {
        Err(CoreError::Invalid(said)) => assert!(said.contains("filling its tables"), "{said}"),
        other => panic!("fill_tables was not refused: {other:?}"),
    }
    fault::release(CLAIMED);
    held.recv_timeout(LONG).unwrap().unwrap();
}

#[test]
fn closing_a_copy_while_a_call_waits_for_a_fill_ends_the_call() {
    let copy = copy();
    let held = held_hold(&copy.core);
    let heard = Arc::new(Heard::default());
    let listening = watch(&copy.core, &heard);
    source_waits(&heard, 0);
    let (stop, caught_up) = catch_up(&copy.core);
    waits_for_fill(&caught_up, 1);
    let closed = Instant::now();
    listening.stop();
    stop.store(true, Ordering::SeqCst);
    let ended = caught_up
        .recv_timeout(SOON)
        .expect("the catch-up did not end");
    assert_eq!(
        ended.map_err(|failed| failed.error),
        Err(CoreError::Canceled)
    );
    wait_until("the watch's follow did not end", || {
        copy.core.claim_follow().is_ok()
    });
    wait_until("the listener was never told it ended", || {
        !heard.ended.lock().unwrap().is_empty()
    });
    assert!(closed.elapsed() < SOON, "{:?}", closed.elapsed());
    fault::release(CLAIMED);
    assert_eq!(filled(&held).whole, 1);
    let Copy {
        _dir,
        path,
        server,
        core,
        ..
    } = copy;
    drop(listening);
    drop(core);
    let reopened = open(&path, &server);
    assert_eq!(state(&reopened, STEPS).as_deref(), Some("whole"));
    assert_eq!(cursor(&reopened).as_deref(), Some("10"));
    assert_eq!(failed(&heard), 0);
}
