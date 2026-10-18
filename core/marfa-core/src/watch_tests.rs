use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::catch_up::{Change, ChangeEvent, Pace};
use crate::scripted::{self, Answer, Scripted, Then};
use crate::watch::{SavesPace, WatchListener};
use crate::{Core, CoreError, Draft, store};

const NOTE: &str = "core.note";
const MS: fn(u64) -> Duration = Duration::from_millis;

const QUICK: Pace = Pace {
    stop_poll: Duration::from_millis(10),
    silence: Duration::from_secs(60),
    reconnect_first: Duration::from_millis(10),
    reconnect_most: Duration::from_millis(40),
    clock: &Instant::now,
};

const FAST_SAVES: SavesPace = SavesPace {
    poll: Duration::from_millis(10),
    retry_most: Duration::from_millis(40),
};

/// What a listener was told, in order.
#[derive(Default)]
struct Heard {
    changes: Mutex<Vec<Change>>,
    ended: Mutex<Vec<Option<CoreError>>>,
    /// Each change takes this long to be told.
    slow: Option<Duration>,
    /// The core's strong count when it was told it ended.
    held_at_end: Mutex<Option<usize>>,
    core: Mutex<Option<Arc<Core>>>,
    panics: bool,
}

impl WatchListener for Heard {
    fn changed(&self, change: &Change) {
        if self.panics {
            panic!("a listener that faults");
        }
        if let Some(slow) = self.slow {
            thread::sleep(slow);
        }
        self.changes.lock().unwrap().push(change.clone());
    }

    fn ended(&self, error: Option<CoreError>) {
        if let Some(core) = self.core.lock().unwrap().take() {
            *self.held_at_end.lock().unwrap() = Some(Arc::strong_count(&core) - 1);
        }
        self.ended.lock().unwrap().push(error);
    }
}

impl Heard {
    fn events(&self) -> Vec<ChangeEvent> {
        self.changes
            .lock()
            .unwrap()
            .iter()
            .map(|change| change.event.clone())
            .collect()
    }

    /// Without `catalog.changed`, which the first stream tells where the
    /// scripted catalog differs from the copy's.
    fn kinds(&self) -> Vec<String> {
        self.events()
            .iter()
            .map(|event| event.as_str().to_string())
            .filter(|kind| kind != "catalog.changed")
            .collect()
    }

    fn ids(&self) -> Vec<String> {
        self.changes
            .lock()
            .unwrap()
            .iter()
            .filter_map(|change| change.item_id.clone())
            .collect()
    }

    fn wait_for(&self, what: &str, mut done: impl FnMut(&[Change]) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !done(&self.changes.lock().unwrap()) {
            assert!(Instant::now() < until, "{what}; heard {:?}", self.kinds());
            thread::sleep(MS(5));
        }
    }

    fn wait_for_kind(&self, kind: &str, count: usize) {
        self.wait_for(&format!("{count} of {kind} were not told"), |changes| {
            changes
                .iter()
                .filter(|change| change.event.as_str() == kind)
                .count()
                >= count
        });
    }

    fn wait_for_end(&self) {
        let until = Instant::now() + Duration::from_secs(10);
        while self.ended.lock().unwrap().is_empty() {
            assert!(
                Instant::now() < until,
                "the listener was never told it ended"
            );
            thread::sleep(MS(5));
        }
    }
}

fn listener() -> Arc<Heard> {
    Arc::new(Heard::default())
}

fn copy(server: &Scripted) -> Arc<Core> {
    let core = crate::stop_tests::copy(server);
    core.watch.set_follow_pace(QUICK);
    core
}

fn payload(event: &str, id: &str) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(&scripted::item_payload(event, id, NOTE, 1)).unwrap();
    value["listed"] = true.into();
    value.to_string()
}

fn created(id: &str, cursor: &str) -> String {
    scripted::event(cursor, "item.created", &payload("item.created", id))
}

fn stream(mut frames: Vec<String>, then: Then) -> Answer {
    let head = frames
        .iter()
        .find_map(|frame| frame.lines().find_map(|line| line.strip_prefix("id: ")))
        .unwrap_or("10")
        .to_string();
    frames.insert(0, scripted::copy_marker("stream_cursor", &head));
    frames.insert(0, scripted::connected());
    scripted::stream(frames, then)
}

fn held() -> Then {
    Then::Hold {
        keepalive: Some(MS(5)),
        lasting: None,
    }
}

fn at_head(cursor: &str) -> Answer {
    scripted::stream(
        vec![
            scripted::connected(),
            scripted::copy_marker("stream_cursor", cursor),
            scripted::copy_marker("stream_live", cursor),
        ],
        Then::End,
    )
}

fn held_answer(frames: Vec<String>) -> Answer {
    stream(frames, held())
}

fn watch(core: &Arc<Core>, listener: &Arc<Heard>) -> crate::Listening {
    core.watch(false, Arc::clone(listener) as Arc<dyn WatchListener>)
        .unwrap()
}

/// The server answers a request it does not name the contract of.
fn another_contract() -> Answer {
    Answer::Json {
        status: 200,
        body: "{}".into(),
        headers: vec![(
            crate::http::CONTRACT_HEADER.into(),
            (crate::contract::CONTRACT_VERSION + 1).to_string(),
        )],
    }
}

/// An answer released when the test says, so a follow stays where it is.
fn until(ready: &Arc<AtomicBool>, answer: Answer) -> Answer {
    Answer::WaitFor {
        ready: Arc::clone(ready),
        answer: Box::new(answer),
    }
}

#[test]
fn one_stream_is_read_for_every_listener_and_each_is_told_in_order() {
    let server = Scripted::start();
    let core = copy(&server);
    // Held until both have joined, so neither joins after a change is told.
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![until(
            &ready,
            held_answer(vec![created("n1", "11"), created("n2", "12")]),
        )],
    );
    let (first, second) = (listener(), listener());
    let _one = watch(&core, &first);
    let _two = watch(&core, &second);
    ready.store(true, Ordering::Relaxed);
    for heard in [&first, &second] {
        heard.wait_for_kind("item.created", 2);
        assert_eq!(heard.ids(), ["n1", "n2"]);
    }
    thread::sleep(MS(100));
    assert_eq!(
        server.seen("/events").len(),
        1,
        "a second listener opened a second stream"
    );
}

#[test]
fn a_listener_that_joins_while_the_server_is_gone_is_told_so_first_and_then_that_it_is_back() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![
            scripted::refusal(503, "unavailable"),
            until(&ready, held_answer(vec![created("n1", "11")])),
        ],
    );
    let (early, late) = (listener(), listener());
    let _one = watch(&core, &early);
    early.wait_for_kind("server.unreachable", 1);
    let _two = watch(&core, &late);
    late.wait_for_kind("server.unreachable", 1);
    assert_eq!(late.kinds(), ["server.unreachable"]);
    ready.store(true, Ordering::Relaxed);
    for heard in [&early, &late] {
        heard.wait_for_kind("item.created", 1);
        assert_eq!(
            heard.kinds(),
            ["server.unreachable", "server.reachable", "item.created"],
            "each listener is told the loss and the return once, in order"
        );
    }
}

#[test]
fn a_listener_that_joins_after_an_event_hears_only_what_follows() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![stream(
            vec![created("n1", "11")],
            Then::Later {
                keepalive: MS(5),
                after: MS(400),
                frames: vec![created("n2", "12")],
            },
        )],
    );
    let (early, late) = (listener(), listener());
    let _one = watch(&core, &early);
    early.wait_for_kind("item.created", 1);
    let _two = watch(&core, &late);
    early.wait_for_kind("item.created", 2);
    late.wait_for_kind("item.created", 1);
    assert_eq!(early.ids(), ["n1", "n2"]);
    assert_eq!(late.ids(), ["n2"]);
}

#[test]
fn a_listener_let_go_is_told_it_ended_once_and_nothing_after_while_the_rest_go_on() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![until(
            &ready,
            stream(
                vec![created("n1", "11")],
                Then::Later {
                    keepalive: MS(5),
                    after: MS(300),
                    frames: vec![created("n2", "12")],
                },
            ),
        )],
    );
    let (leaving, staying) = (listener(), listener());
    let gone = watch(&core, &leaving);
    let _kept = watch(&core, &staying);
    ready.store(true, Ordering::Relaxed);
    leaving.wait_for_kind("item.created", 1);
    gone.stop();
    gone.stop();
    leaving.wait_for_end();
    staying.wait_for_kind("item.created", 2);
    assert_eq!(leaving.ids(), ["n1"], "a listener let go was told on");
    assert_eq!(leaving.ended.lock().unwrap().len(), 1);
    assert_eq!(*leaving.ended.lock().unwrap(), [None]);
    assert!(staying.ended.lock().unwrap().is_empty());
}

#[test]
fn the_store_is_let_go_before_the_last_listener_is_told_it_ended() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on("/events", vec![held_answer(vec![created("n1", "11")])]);
    let heard = listener();
    *heard.core.lock().unwrap() = Some(Arc::clone(&core));
    let listening = watch(&core, &heard);
    heard.wait_for_kind("item.created", 1);
    drop(listening);
    heard.wait_for_end();
    assert_eq!(
        *heard.held_at_end.lock().unwrap(),
        Some(1),
        "the watch still held the store when its last listener was told it ended"
    );
    // The watch starts again for a listener that comes after.
    let again = listener();
    let _next = watch(&core, &again);
    again.wait_for_kind("item.created", 1);
}

#[test]
fn a_listener_that_faults_is_removed_and_the_others_go_on() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![until(
            &ready,
            held_answer(vec![created("n1", "11"), created("n2", "12")]),
        )],
    );
    let faulting = Arc::new(Heard {
        panics: true,
        ..Heard::default()
    });
    let steady = listener();
    let _one = watch(&core, &faulting);
    let _two = watch(&core, &steady);
    ready.store(true, Ordering::Relaxed);
    steady.wait_for_kind("item.created", 2);
    faulting.wait_for_end();
    assert!(matches!(
        faulting.ended.lock().unwrap().first(),
        Some(Some(CoreError::Invalid(_)))
    ));
    assert_eq!(steady.ids(), ["n1", "n2"]);
}

#[test]
fn a_dispatcher_that_falls_behind_makes_the_source_wait_and_loses_nothing() {
    let server = Scripted::start();
    let core = copy(&server);
    let frames: Vec<String> = (0..1500)
        .map(|n| created(&format!("n{n}"), &(11 + n).to_string()))
        .collect();
    let ready = Arc::new(AtomicBool::new(false));
    server.on("/events", vec![until(&ready, held_answer(frames))]);
    let (first, second) = (listener(), listener());
    let _one = watch(&core, &first);
    let _two = watch(&core, &second);
    // The source is asking, so the dispatcher is past its first turn.
    server.wait_for("/events", 1, Duration::from_secs(5));
    // Held where it takes what is queued, while the stream floods in.
    core.watch.held_up.store(true, Ordering::SeqCst);
    ready.store(true, Ordering::Relaxed);
    let until = Instant::now() + Duration::from_secs(20);
    while core.watch.queued_changes() < 1_000 {
        assert!(Instant::now() < until, "the queue never filled");
        thread::sleep(MS(5));
    }
    // More than a queue holds is in the stream, and the source waits for room.
    thread::sleep(MS(200));
    assert!(core.watch.queued_changes() <= 1_024 + 1);
    core.watch.held_up.store(false, Ordering::SeqCst);
    first.wait_for_kind("item.created", 1500);
    second.wait_for_kind("item.created", 1500);
    let expected: Vec<String> = (0..1500).map(|n| format!("n{n}")).collect();
    assert_eq!(first.ids(), expected);
    assert_eq!(second.ids(), expected);
}

#[test]
fn a_catch_up_takes_the_stream_and_gives_it_back_without_ending_a_listener() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![
            held_answer(vec![created("n1", "11")]),
            at_head("11"),
            held_answer(vec![created("n2", "12")]),
        ],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("item.created", 1);
    core.catch_up().unwrap();
    heard.wait_for_kind("item.created", 2);
    assert_eq!(heard.ids(), ["n1", "n2"]);
    assert!(heard.ended.lock().unwrap().is_empty());
    assert_eq!(server.seen("/events").len(), 3);
}

#[test]
fn a_hydration_or_catch_up_from_inside_a_listener_is_refused_rather_than_waiting_on_itself() {
    struct Calls {
        core: Mutex<Option<Arc<Core>>>,
        refused: mpsc::Sender<CoreError>,
    }
    impl WatchListener for Calls {
        fn changed(&self, _: &Change) {
            if let Some(core) = self.core.lock().unwrap().take() {
                let _ = self.refused.send(core.catch_up().unwrap_err());
            }
        }
        fn ended(&self, _: Option<CoreError>) {}
    }
    let server = Scripted::start();
    let core = copy(&server);
    server.on("/events", vec![held_answer(vec![created("n1", "11")])]);
    let (refused, told) = mpsc::channel();
    let _listening = core
        .watch(
            false,
            Arc::new(Calls {
                core: Mutex::new(Some(Arc::clone(&core))),
                refused,
            }),
        )
        .unwrap();
    let error = told
        .recv_timeout(Duration::from_secs(5))
        .expect("a catch-up called from a listener waited on the thread that was calling it");
    assert!(matches!(error, CoreError::Invalid(_)), "{error:?}");
}

#[test]
fn a_catch_up_that_reaches_the_server_ends_the_outage_even_when_the_follow_it_restarts_fails() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![
            scripted::refusal(503, "unavailable"),
            until(&ready, scripted::refusal(503, "unavailable")),
            at_head("10"),
            another_contract(),
        ],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("server.unreachable", 1);
    // Held on its second ask, so the catch-up is the next stream anyone has.
    server.wait_for("/events", 2, Duration::from_secs(5));
    core.catch_up().unwrap();
    heard.wait_for_kind("watch.failed", 1);
    assert_eq!(
        heard.kinds(),
        ["server.unreachable", "server.reachable", "watch.failed"],
        "a listener was left showing the server unreachable once a request had reached it"
    );
    assert!(matches!(
        heard.events().last(),
        Some(ChangeEvent::WatchFailed(CoreError::ContractMismatch { .. }))
    ));
    // A listener that joins now is told what holds, and not the outage.
    let late = listener();
    let _next = watch(&core, &late);
    late.wait_for_kind("watch.failed", 1);
    thread::sleep(MS(50));
    assert_eq!(late.kinds(), ["watch.failed"]);
    ready.store(true, Ordering::Relaxed);
}

#[test]
fn a_follow_that_ends_on_the_servers_own_answer_ends_the_outage_too() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![scripted::refusal(503, "unavailable"), another_contract()],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("watch.failed", 1);
    assert_eq!(
        heard.kinds(),
        ["server.unreachable", "server.reachable", "watch.failed"]
    );
}

#[test]
fn a_failed_follow_starts_again_after_the_next_catch_up_and_a_listener_that_joined_meanwhile_was_told()
 {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![
            another_contract(),
            at_head("10"),
            held_answer(vec![created("n1", "11")]),
        ],
    );
    let early = listener();
    let _one = watch(&core, &early);
    early.wait_for_kind("watch.failed", 1);
    let late = listener();
    let _two = watch(&core, &late);
    late.wait_for_kind("watch.failed", 1);
    thread::sleep(MS(100));
    assert_eq!(
        server.seen("/events").len(),
        1,
        "a failed follow asked for a stream again on its own"
    );
    core.catch_up().unwrap();
    for heard in [&early, &late] {
        heard.wait_for_kind("item.created", 1);
        assert_eq!(heard.kinds(), ["watch.failed", "item.created"]);
    }
}

fn queue_note(core: &Core, server: &Scripted, title: &str) -> (String, Answer) {
    let created = core
        .create_item(&Draft {
            r#type: NOTE.into(),
            properties: serde_json::json!({ "title": title, "body": "b" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap();
    let id = created.item_id.unwrap();
    let item = serde_json::from_str::<serde_json::Value>(&scripted::item_payload(
        "item.created",
        &id,
        NOTE,
        1,
    ))
    .unwrap()["item"]
        .clone();
    let current = serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true });
    server.on(
        &format!("/items/{id}"),
        vec![scripted::certified(scripted::json(
            200,
            &current.to_string(),
        ))],
    );
    server.on(
        "/items/lookup",
        vec![scripted::json(200, r#"{"data":[],"tombstones":[]}"#)],
    );
    (
        id,
        scripted::json(201, &serde_json::json!({ "item": item }).to_string()),
    )
}

fn creates(server: &Scripted) -> usize {
    server.seen("/items").len()
}

#[test]
fn a_drain_that_leaves_a_write_undelivered_is_finished_by_the_next_stream_the_watch_has() {
    let server = Scripted::start();
    let core = copy(&server);
    let (_, first) = queue_note(&core, &server, "first");
    let (_, second) = queue_note(&core, &server, "second");
    server.on(
        "/items",
        vec![first, scripted::refusal(503, "unavailable"), second],
    );
    server.on("/events", vec![held_answer(vec![])]);
    let partial = core.drain().unwrap();
    assert_eq!((partial.answered, partial.undelivered), (1, 1));
    assert!(store::drain_owed(&core.conn().unwrap()).unwrap());
    let sent = creates(&server);

    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("queue.drained", 1);
    let report = heard
        .events()
        .into_iter()
        .find_map(|event| match event {
            ChangeEvent::QueueDrained(report) => Some(report),
            _ => None,
        })
        .unwrap();
    assert_eq!((report.answered, report.undelivered), (1, 0));
    assert_eq!(creates(&server), sent + 1);
    assert!(!store::drain_owed(&core.conn().unwrap()).unwrap());
    // Nobody was told the server was gone, so nobody is told it is back.
    assert_eq!(heard.kinds(), ["queue.drained"]);
}

#[test]
fn a_write_the_app_holds_is_not_drained_by_a_watch_whose_server_was_never_lost() {
    let server = Scripted::start();
    let core = copy(&server);
    let (_, took) = queue_note(&core, &server, "held");
    server.on("/items", vec![took]);
    server.on("/events", vec![held_answer(vec![created("n1", "11")])]);
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("item.created", 1);
    thread::sleep(MS(150));
    assert_eq!(creates(&server), 0, "a watch drained what the app held");
    assert_eq!(heard.kinds(), ["item.created"]);
}

#[test]
fn a_drain_the_app_starts_that_reaches_the_server_ends_the_outage_and_the_next_loss_is_told_again()
{
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    let (_, took) = queue_note(&core, &server, "waiting");
    server.on("/items", vec![took]);
    server.on(
        "/events",
        vec![
            scripted::refusal(503, "unavailable"),
            until(&ready, scripted::refusal(503, "unavailable")),
            scripted::refusal(503, "unavailable"),
        ],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("server.unreachable", 1);
    server.wait_for("/events", 2, Duration::from_secs(5));
    assert_eq!(core.drain().unwrap().answered, 1);
    heard.wait_for_kind("server.reachable", 1);
    heard.wait_for_kind("server.unreachable", 2);
    assert_eq!(
        heard.kinds(),
        [
            "server.unreachable",
            "server.reachable",
            "server.unreachable"
        ]
    );
    ready.store(true, Ordering::Relaxed);
}

#[test]
fn a_store_with_no_server_cannot_be_watched() {
    let core = Arc::new(Core::open_in_memory(None).unwrap());
    let refused = core.watch(false, listener() as Arc<dyn WatchListener>);
    assert!(matches!(refused, Err(CoreError::NoServer)));
}

fn reader_of(dir: &tempfile::TempDir) -> (Arc<Core>, Arc<Core>) {
    let path = dir.path().join("core.sqlite");
    let writer = Arc::new(Core::open(&path, None).unwrap());
    let reader = Arc::new(Core::open_reader(&path).unwrap());
    (writer, reader)
}

fn save(core: &Core, title: &str) {
    core.create_item(&Draft {
        r#type: NOTE.into(),
        properties: serde_json::json!({ "title": title, "body": "b" })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    })
    .unwrap();
}

#[test]
fn a_reading_handles_listeners_are_told_each_save_after_the_version_they_read() {
    let dir = tempfile::tempdir().unwrap();
    let (writer, reader) = reader_of(&dir);
    let (first, second) = (listener(), listener());
    let _one = reader
        .watch_paced(
            false,
            Arc::clone(&first) as Arc<dyn WatchListener>,
            FAST_SAVES,
        )
        .unwrap();
    // The version it read when it joined is not a save.
    thread::sleep(MS(100));
    assert!(
        first.changes.lock().unwrap().is_empty(),
        "a listener was told a save before any was made"
    );
    save(&writer, "one");
    first.wait_for_kind("store.saved", 1);
    let between = reader.data_version().unwrap();
    let _two = reader
        .watch_paced(
            false,
            Arc::clone(&second) as Arc<dyn WatchListener>,
            FAST_SAVES,
        )
        .unwrap();
    save(&writer, "two");
    for heard in [&first, &second] {
        heard.wait_for("the second save was not told", |changes| {
            matches!(
                changes.last(),
                Some(Change { event: ChangeEvent::Saved(version), .. }) if *version > between
            )
        });
    }
    let versions = |heard: &Heard| -> Vec<i64> {
        heard
            .events()
            .into_iter()
            .filter_map(|event| match event {
                ChangeEvent::Saved(version) => Some(version),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        versions(&second).len(),
        1,
        "a listener was told a save from before it joined"
    );
    assert!(versions(&first).windows(2).all(|pair| pair[0] < pair[1]));
    // Quiet, it tells nothing.
    let told = first.changes.lock().unwrap().len();
    thread::sleep(MS(100));
    assert_eq!(first.changes.lock().unwrap().len(), told);
}

#[test]
fn a_reader_that_fails_to_read_says_so_once_and_tells_every_listener_a_save_when_it_reads_again() {
    let reads = Arc::new(Mutex::new(vec![
        Ok(5),
        Err(CoreError::Store("busy".into())),
        Err(CoreError::Store("busy".into())),
        Ok(5),
    ]));
    let told = Arc::new(Mutex::new(Vec::new()));
    let stop = AtomicBool::new(false);
    let read = {
        let reads = Arc::clone(&reads);
        let stop = &stop;
        move || {
            let mut reads = reads.lock().unwrap();
            if reads.len() <= 1 {
                stop.store(true, Ordering::Relaxed);
            }
            reads.remove(0)
        }
    };
    let record = {
        let told = Arc::clone(&told);
        move |event: crate::watch::Told| {
            told.lock().unwrap().push(match event {
                crate::watch::Told::Saved { version, forced } => {
                    format!("saved {version} {forced}")
                }
                crate::watch::Told::SavesFailed(_) => "failed".to_string(),
                _ => "other".to_string(),
            });
        }
    };
    crate::watch::read_saves(&read, &stop, FAST_SAVES, &record);
    assert_eq!(
        *told.lock().unwrap(),
        ["saved 5 false", "failed", "saved 5 true"],
        "a failure was told more than once, or a read that mended it told no one a save"
    );
}

#[test]
fn a_listener_that_says_it_was_told_unreachable_is_told_reachable_when_it_joins_a_held_stream() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on("/events", vec![held_answer(vec![created("n1", "11")])]);
    let early = listener();
    let _one = watch(&core, &early);
    early.wait_for_kind("item.created", 1);
    let late = listener();
    let _two = core
        .watch(true, Arc::clone(&late) as Arc<dyn WatchListener>)
        .unwrap();
    late.wait_for_kind("server.reachable", 1);
    // The witness: one that says nothing of an outage is told nothing.
    let quiet = listener();
    let _three = watch(&core, &quiet);
    thread::sleep(MS(150));
    assert_eq!(late.kinds(), ["server.reachable"]);
    assert!(quiet.kinds().is_empty());
}

#[test]
fn an_outage_a_slow_listener_hears_late_does_not_owe_a_drain_the_follow_already_paid() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![
            stream(vec![created("n1", "11")], Then::End),
            scripted::refusal(503, "unavailable"),
            // At the cursor the first stream left.
            scripted::stream(
                vec![
                    scripted::connected(),
                    scripted::copy_marker("stream_cursor", "11"),
                ],
                held(),
            ),
        ],
    );
    // Hears the first change slowly, so the dispatcher is behind the follow
    // when the follow loses the server and has it back.
    let slow = Arc::new(Heard {
        slow: Some(MS(400)),
        ..Heard::default()
    });
    let _listening = watch(&core, &slow);
    server.wait_for("/events", 3, Duration::from_secs(5));
    slow.wait_for_kind("server.reachable", 1);
    thread::sleep(MS(300));
    assert!(
        !store::drain_owed(&core.conn().unwrap()).unwrap(),
        "an outage told late set the debt again after the follow paid it"
    );
}

#[test]
fn a_failure_told_after_a_catch_up_names_the_cursor_the_catch_up_left() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![
            another_contract(),
            stream(
                vec![
                    created("n1", "11"),
                    created("n2", "12"),
                    scripted::copy_marker("stream_live", "12"),
                ],
                Then::End,
            ),
            another_contract(),
        ],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("watch.failed", 1);
    core.catch_up().unwrap();
    heard.wait_for_kind("watch.failed", 2);
    let cursors: Vec<String> = heard
        .changes
        .lock()
        .unwrap()
        .iter()
        .filter(|change| change.event.as_str() == "watch.failed")
        .map(|change| change.cursor.clone())
        .collect();
    assert_eq!(cursors, ["10", "12"]);
}

#[test]
fn a_save_is_told_with_the_cursor_the_store_holds_then() {
    let dir = tempfile::tempdir().unwrap();
    let (writer, reader) = reader_of(&dir);
    let heard = listener();
    let _listening = reader
        .watch_paced(
            false,
            Arc::clone(&heard) as Arc<dyn WatchListener>,
            FAST_SAVES,
        )
        .unwrap();
    thread::sleep(MS(100));
    store::meta_set(&writer.conn().unwrap(), store::META_EVENT_CURSOR, "42").unwrap();
    heard.wait_for_kind("store.saved", 1);
    assert_eq!(heard.changes.lock().unwrap()[0].cursor, "42");
}

/// Runs `call` on another thread and gives up on it after a few seconds, so
/// a hang fails the test instead of stopping the run.
fn within<T: Send + 'static>(what: &str, call: impl FnOnce() -> T + Send + 'static) -> T {
    let (sent, got) = mpsc::channel();
    thread::spawn(move || {
        let _ = sent.send(call());
    });
    got.recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| panic!("{what} waited for good"))
}

#[test]
fn a_watch_started_after_a_fault_in_the_dispatcher_works_and_a_catch_up_is_not_held() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![
            held_answer(vec![created("n1", "11")]),
            held_answer(vec![created("n2", "12")]),
            at_head("12"),
            held_answer(vec![created("n3", "13")]),
        ],
    );
    let first = listener();
    let _one = watch(&core, &first);
    first.wait_for_kind("item.created", 1);
    core.watch.fault_once.store(true, Ordering::SeqCst);
    // Joins on the turn that faults.
    let second = listener();
    let _two = watch(&core, &second);
    for heard in [&first, &second] {
        heard.wait_for_end();
        assert!(matches!(
            heard.ended.lock().unwrap().first(),
            Some(Some(CoreError::Invalid(_)))
        ));
    }
    let again = listener();
    let _three = watch(&core, &again);
    again.wait_for_kind("item.created", 1);
    thread::sleep(MS(200));
    assert_eq!(again.kinds(), ["item.created"], "{:?}", again.kinds());
    // A catch-up while the new watch exists takes its stream.
    let caught = Arc::clone(&core);
    within("a catch-up after a dispatcher fault", move || {
        caught.catch_up().unwrap()
    });
    again.wait_for_kind("item.created", 2);
    assert_eq!(again.ids(), ["n2", "n3"]);
}

#[test]
fn a_catch_up_called_as_the_dispatcher_faults_is_not_held() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![held_answer(vec![created("n1", "11")]), at_head("11")],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("item.created", 1);
    // The turn the call wakes is the one that faults, with the source's end
    // still to come.
    core.watch.fault_once.store(true, Ordering::SeqCst);
    let caught = Arc::clone(&core);
    within("a catch-up as the dispatcher faulted", move || {
        caught.catch_up().unwrap()
    });
    heard.wait_for_end();
}

#[test]
fn server_reachable_after_a_catch_up_carries_the_cursor_the_catch_up_left() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![
            scripted::refusal(503, "unavailable"),
            until(&ready, scripted::refusal(503, "unavailable")),
            stream(
                vec![
                    created("n1", "11"),
                    created("n2", "12"),
                    scripted::copy_marker("stream_live", "12"),
                ],
                Then::End,
            ),
            scripted::stream(
                vec![
                    scripted::connected(),
                    scripted::copy_marker("stream_cursor", "12"),
                ],
                held(),
            ),
        ],
    );
    let heard = listener();
    let _listening = watch(&core, &heard);
    heard.wait_for_kind("server.unreachable", 1);
    server.wait_for("/events", 2, Duration::from_secs(5));
    core.catch_up().unwrap();
    heard.wait_for_kind("server.reachable", 1);
    let reachable = heard
        .changes
        .lock()
        .unwrap()
        .iter()
        .find(|change| change.event.as_str() == "server.reachable")
        .cloned()
        .unwrap();
    assert_eq!(reachable.cursor, "12");
    ready.store(true, Ordering::Relaxed);
}

#[test]
fn a_joiner_is_told_the_state_as_of_its_join_not_a_later_one_a_slow_listener_has_not_reached() {
    let server = Scripted::start();
    let core = copy(&server);
    let ready = Arc::new(AtomicBool::new(false));
    server.on(
        "/events",
        vec![
            stream(vec![created("n1", "11")], Then::End),
            scripted::refusal(503, "unavailable"),
            until(
                &ready,
                scripted::stream(
                    vec![
                        scripted::connected(),
                        scripted::copy_marker("stream_cursor", "11"),
                    ],
                    held(),
                ),
            ),
        ],
    );
    // Busy with the first change while the follow loses the server.
    let slow = Arc::new(Heard {
        slow: Some(MS(500)),
        ..Heard::default()
    });
    let _one = watch(&core, &slow);
    server.wait_for("/events", 3, Duration::from_secs(5));
    let joiner = listener();
    let _two = core
        .watch(true, Arc::clone(&joiner) as Arc<dyn WatchListener>)
        .unwrap();
    thread::sleep(MS(1_500));
    assert!(
        joiner.kinds().is_empty(),
        "a joiner was told {:?} on evidence the queue had already outdated",
        joiner.kinds()
    );
    ready.store(true, Ordering::Relaxed);
    joiner.wait_for_kind("server.reachable", 1);
}

#[test]
fn a_joiner_hears_nothing_that_was_queued_before_it_joined() {
    let server = Scripted::start();
    let core = copy(&server);
    let (entered, ready) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    server.on(
        "/events",
        vec![stream(
            vec![created("n0", "11")],
            Then::WaitFor {
                entered: Arc::clone(&entered),
                ready: Arc::clone(&ready),
                then: Box::new(Then::Later {
                    keepalive: MS(5),
                    after: MS(0),
                    frames: vec![
                        created("n1", "12"),
                        created("n2", "13"),
                        created("n3", "14"),
                    ],
                }),
            },
        )],
    );
    let early = listener();
    let _one = watch(&core, &early);
    early.wait_for_kind("item.created", 1);
    assert!(entered.load(Ordering::SeqCst));
    // The dispatcher is held at its next turn, so the three are queued
    // before the joiner joins and are taken together with it.
    core.watch.held_up.store(true, Ordering::SeqCst);
    let before = core.watch.pushed();
    ready.store(true, Ordering::SeqCst);
    let until = Instant::now() + Duration::from_secs(20);
    while core.watch.pushed() < before + 3 {
        assert!(Instant::now() < until, "the three were never queued");
        thread::sleep(MS(5));
    }
    let joiner = listener();
    let _two = watch(&core, &joiner);
    core.watch.held_up.store(false, Ordering::SeqCst);
    early.wait_for_kind("item.created", 4);
    thread::sleep(MS(200));
    assert!(
        joiner.ids().is_empty(),
        "a joiner heard {:?}, which was queued before it joined",
        joiner.ids()
    );
}

#[test]
fn a_catch_up_that_succeeds_as_the_dispatcher_starts_still_ends_the_outage_a_joiner_says_it_was_told()
 {
    let server = Scripted::start();
    let core = copy(&server);
    server.on(
        "/events",
        vec![at_head("10"), scripted::refusal(503, "unavailable")],
    );
    // The dispatcher is made but held before its first turn.
    core.watch.held_up.store(true, Ordering::SeqCst);
    let joiner = listener();
    let _listening = core
        .watch(true, Arc::clone(&joiner) as Arc<dyn WatchListener>)
        .unwrap();
    core.catch_up().unwrap();
    core.watch.held_up.store(false, Ordering::SeqCst);
    joiner.wait_for_kind("server.reachable", 1);
    assert_eq!(joiner.kinds()[0], "server.reachable");
}

#[test]
fn the_store_is_let_go_before_a_last_listener_is_told_it_ended_while_a_faulted_source_ends() {
    let server = Scripted::start();
    let core = copy(&server);
    // A source that is slow to notice it was stopped.
    core.watch.set_follow_pace(Pace {
        stop_poll: MS(300),
        ..QUICK
    });
    server.on(
        "/events",
        vec![
            stream(
                vec![created("n1", "11")],
                Then::Hold {
                    keepalive: None,
                    lasting: None,
                },
            ),
            held_answer(vec![]),
        ],
    );
    let first = listener();
    let _one = watch(&core, &first);
    first.wait_for_kind("item.created", 1);
    core.watch.fault_once.store(true, Ordering::SeqCst);
    let second = listener();
    let _two = watch(&core, &second);
    first.wait_for_end();
    // The source of the faulted dispatcher is still stopping.
    let last = listener();
    *last.core.lock().unwrap() = Some(Arc::clone(&core));
    let leaving = watch(&core, &last);
    drop(leaving);
    last.wait_for_end();
    assert_eq!(
        *last.held_at_end.lock().unwrap(),
        Some(1),
        "the last listener was told it ended while a source still held the store"
    );
}

#[test]
fn a_drain_on_a_failed_watch_is_no_evidence_for_a_joiner_that_says_it_was_told_unreachable() {
    let server = Scripted::start();
    let core = copy(&server);
    server.on("/events", vec![another_contract()]);
    let (_, took) = queue_note(&core, &server, "waiting");
    server.on("/items", vec![took]);
    let first = listener();
    let _one = watch(&core, &first);
    first.wait_for_kind("watch.failed", 1);
    assert_eq!(core.drain().unwrap().answered, 1);
    thread::sleep(MS(100));
    let joiner = listener();
    let _two = core
        .watch(true, Arc::clone(&joiner) as Arc<dyn WatchListener>)
        .unwrap();
    joiner.wait_for_kind("watch.failed", 1);
    thread::sleep(MS(200));
    assert_eq!(joiner.kinds(), ["watch.failed"]);
}
