use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use crate::scripted::{self, Answer, Scripted, Then};
use crate::{Core, CoreError, Result, Server, SliceTier, store};

const WAIT: Duration = Duration::from_secs(2);

pub(crate) fn copy(server: &Scripted) -> Arc<Core> {
    let core = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: "k".into(),
    }))
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::read_view::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    server.on(
        "/edge-types",
        vec![scripted::certified(scripted::edge_types(&[]))],
    );
    server.on(
        "/keys/current",
        vec![scripted::certified(scripted::json(
            200,
            r#"{"type_permissions":{"core.note":"read"}}"#,
        ))],
    );
    server.on(
        "/events",
        vec![scripted::stream(
            vec![scripted::copy_marker("stream_cursor", "10")],
            Then::End,
        )],
    );
    Arc::new(core)
}

fn stopped<T: Send + 'static>(
    server: &Scripted,
    path: &str,
    answers: Vec<Answer>,
    core: Arc<Core>,
    call: impl FnOnce(&Core, &AtomicBool) -> Result<T> + Send + 'static,
) -> Result<T> {
    let stop = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(AtomicBool::new(false));
    let mut answers = answers.into_iter();
    let first = match answers.next().unwrap() {
        Answer::Stream { frames, then } => Answer::Stream {
            frames,
            then: Then::WaitFor {
                entered: entered.clone(),
                ready: stop.clone(),
                then: Box::new(then),
            },
        },
        answer => {
            entered.store(true, Ordering::Relaxed);
            Answer::WaitFor {
                ready: stop.clone(),
                answer: Box::new(answer),
            }
        }
    };
    server.on(path, std::iter::once(first).chain(answers).collect());
    let (done, result) = mpsc::channel();
    let raised = stop.clone();
    let task = std::thread::spawn(move || {
        let _ = done.send(call(&core, &raised));
    });
    server.wait_for(path, 1, WAIT);
    let waiting = Instant::now();
    while !entered.load(Ordering::Relaxed) {
        assert!(waiting.elapsed() < WAIT, "stream did not send its headers");
        std::thread::sleep(Duration::from_millis(5));
    }
    stop.store(true, Ordering::Relaxed);
    let result = result.recv_timeout(WAIT).expect("stopped call did not end");
    task.join().unwrap();
    result
}

fn hydrate(core: &Core, stop: &AtomicBool) -> Result<crate::HydrateReport> {
    core.hydrate_until(&["core.note".into()], SliceTier::Library, &[], stop)
}

#[test]
fn a_stopped_head_read_does_not_retry_after_eof_or_a_broken_frame() {
    for end in [Then::End, Then::Break] {
        let witness = Scripted::start();
        let core = copy(&witness);
        witness.on("/events", vec![scripted::stream(vec![], end.clone())]);
        assert_eq!(
            hydrate(&core, &AtomicBool::new(false)).unwrap_err(),
            CoreError::StreamIncomplete {
                reason: "replay_failed".into()
            }
        );
        assert_eq!(witness.seen("/events").len(), 3);

        let server = Scripted::start();
        let core = copy(&server);
        assert_eq!(
            stopped(
                &server,
                "/events",
                vec![scripted::stream(vec![], end)],
                core,
                hydrate
            )
            .unwrap_err(),
            CoreError::Canceled
        );
        assert_eq!(server.seen("/events").len(), 1);
    }
}

#[test]
fn a_stopped_hydration_reports_canceled_after_a_failed_read() {
    for path in ["/events", "/types", "/items"] {
        let server = Scripted::start();
        let core = copy(&server);
        core.create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::from_value(serde_json::json!({
                "title": "queued before hydration",
                "body": "keep this save"
            }))
            .unwrap(),
            ..Default::default()
        })
        .unwrap();
        let queue = core.queue().unwrap();
        assert_eq!(
            stopped(
                &server,
                path,
                vec![scripted::refusal(503, "server_unavailable")],
                core.clone(),
                hydrate,
            )
            .unwrap_err(),
            CoreError::Canceled,
            "{path}"
        );
        assert_eq!(core.queue().unwrap(), queue);
    }
}

#[test]
fn a_stopped_read_still_expires_a_copy_when_the_credential_ended() {
    for hydration in [false, true] {
        let server = Scripted::start();
        let core = copy(&server);
        assert_eq!(
            stopped(
                &server,
                "/types",
                vec![scripted::refusal(401, "unauthorized")],
                core.clone(),
                move |core, stop| {
                    if hydration {
                        hydrate(core, stop).map(|_| ())
                    } else {
                        core.catch_up_until(stop).map(|_| ())
                    }
                },
            )
            .unwrap_err(),
            CoreError::Canceled
        );
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
    }
}

#[test]
fn a_stopped_catch_up_reports_canceled_after_a_failed_read() {
    for path in ["/types", "/events"] {
        let server = Scripted::start();
        let core = copy(&server);
        assert_eq!(
            stopped(
                &server,
                path,
                vec![scripted::refusal(503, "server_unavailable")],
                core.clone(),
                Core::catch_up_until,
            )
            .unwrap_err(),
            CoreError::Canceled,
            "{path}"
        );
        assert_eq!(core.status().unwrap().event_cursor.as_deref(), Some("10"));
    }
}

#[test]
fn a_stopped_drain_records_the_in_flight_answer_before_ending() {
    for succeeds in [false, true] {
        let server = Scripted::start();
        let core = copy(&server);
        {
            let conn = core.conn().unwrap();
            let note = store::testing::note("a", "a", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &note, None, &Default::default()).unwrap();
        }
        core.delete_item("a").unwrap();
        let answer = if succeeds {
            vec![
                scripted::json(200, r#"{"ok":true}"#),
                scripted::certified(scripted::refusal(404, "item_not_found")),
            ]
        } else {
            vec![scripted::refusal(503, "server_unavailable")]
        };
        assert_eq!(
            stopped(&server, "/items/a", answer, core.clone(), Core::drain_until).unwrap_err(),
            CoreError::Canceled
        );
        let queue = core.queue().unwrap();
        assert_eq!(queue.len(), 1);
        let sent: bool = core
            .conn()
            .unwrap()
            .query_row(
                "SELECT sent FROM queue WHERE id = ?1",
                [&queue[0].id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sent);
        assert_eq!(queue[0].verdict.is_some(), succeeds);
    }
}

pub(crate) fn note(id: Option<&str>) -> crate::Draft {
    crate::Draft {
        r#type: "core.note".into(),
        id: id.map(str::to_string),
        properties: serde_json::json!({ "title": "a", "body": "b" })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    }
}

pub(crate) fn holding_a_catalog(core: &Core) {
    let conn = core.conn().unwrap();
    store::replace_catalog(&conn, &crate::builtin::catalog().unwrap()).unwrap();
}

/// Takes every connection and answers none, as a server still being reached
/// does: a request to it waits until its own time runs out.
fn silent_server() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming() {
            held.push(stream);
        }
    });
    url
}

fn copy_at(url: &str) -> Arc<Core> {
    let core = Core::open_in_memory(Some(Server {
        url: url.into(),
        key: "k".into(),
    }))
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::read_view::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    holding_a_catalog(&core);
    Arc::new(core)
}

fn ends_soon_after_its_stop(
    core: Arc<Core>,
    call: impl FnOnce(&Core, &AtomicBool) -> Result<()> + Send + 'static,
) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let (done, result) = mpsc::channel();
    let raised = stop.clone();
    std::thread::spawn(move || {
        let _ = done.send(call(&core, &raised));
    });
    std::thread::sleep(Duration::from_millis(100));
    let raised_at = Instant::now();
    stop.store(true, Ordering::Relaxed);
    let result = result
        .recv_timeout(WAIT)
        .expect("a stopped call still waited on its request");
    assert!(raised_at.elapsed() < WAIT);
    result
}

#[test]
fn a_stop_ends_a_call_whose_first_request_waits_on_a_silent_server() {
    let url = silent_server();
    let fresh = Arc::new(
        Core::open_in_memory(Some(Server {
            url: url.clone(),
            key: "k".into(),
        }))
        .unwrap(),
    );
    assert_eq!(
        ends_soon_after_its_stop(fresh.clone(), |core, stop| hydrate(core, stop).map(|_| ())),
        Err(CoreError::Canceled)
    );
    assert_eq!(
        ends_soon_after_its_stop(fresh, |core, stop| core
            .server_catalog_until(stop)
            .map(|_| ())),
        Err(CoreError::Canceled)
    );
    assert_eq!(
        ends_soon_after_its_stop(copy_at(&url), |core, stop| hydrate(core, stop).map(|_| ())),
        Err(CoreError::Canceled)
    );
    assert_eq!(
        ends_soon_after_its_stop(copy_at(&url), |core, stop| core
            .catch_up_until(stop)
            .map(|_| ())),
        Err(CoreError::Canceled)
    );
    let draining = copy_at(&url);
    draining.create_item(&note(None)).unwrap();
    assert_eq!(
        ends_soon_after_its_stop(draining.clone(), |core, stop| core
            .drain_until(stop)
            .map(|_| ())),
        Err(CoreError::Canceled)
    );
    let queue = draining.queue().unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].verdict, None);
}

#[test]
fn a_stopped_read_finishes_a_renewal_under_way_and_starts_none_after() {
    use std::sync::atomic::AtomicUsize;
    let server = Scripted::start();
    // The catalog is read in two requests, each refused once: the first
    // renews while the stop is raised, and the second would renew again.
    server.on(
        "/types",
        vec![
            scripted::refusal(401, "unauthorized"),
            scripted::types(&[("core.note", None)]),
        ],
    );
    server.on("/edge-types", vec![scripted::refusal(401, "unauthorized")]);
    let http = crate::http::Http::new(&server.url(), "k").unwrap();
    let (started, kept) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicBool::new(false)),
    );
    let (renewing, renewed) = (started.clone(), kept.clone());
    http.renew_with(Box::new(move |_| {
        let renewal = renewing.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(400));
        renewed.store(true, Ordering::SeqCst);
        Ok(format!("fresh-{renewal}"))
    }));
    let stop = AtomicBool::new(false);
    let result = std::thread::scope(|scope| {
        scope.spawn(|| {
            while started.load(Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
            stop.store(true, Ordering::Relaxed);
        });
        crate::catch_up::read_unless_stopped(&stop, &http, crate::http::Http::catalog)
    });
    assert!(matches!(result, Err(CoreError::Canceled)));
    assert!(
        kept.load(Ordering::SeqCst),
        "the call ended while a renewal it started was still under way"
    );
    server.wait_for("/edge-types", 1, WAIT);
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(
        started.load(Ordering::SeqCst),
        1,
        "a renewal began after the stop"
    );
}
