use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use crate::scripted::{self, Answer, Scripted, Then};
use crate::{Core, CoreError, Result, Server, SliceTier, store};

const WAIT: Duration = Duration::from_secs(2);

pub(crate) fn copy(server: &Scripted) -> Arc<Core> {
    copy_keyed(server, "k")
}

pub(crate) fn copy_keyed(server: &Scripted, key: &str) -> Arc<Core> {
    let core = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: key.into(),
    }))
    .unwrap();
    scripted_copy(server, core)
}

/// On disk, where a blob's bytes can be held.
fn copy_in(server: &Scripted, dir: &std::path::Path) -> Arc<Core> {
    copy_in_keyed(server, dir, "k")
}

pub(crate) fn copy_in_keyed(server: &Scripted, dir: &std::path::Path, key: &str) -> Arc<Core> {
    let core = Core::open(
        dir.join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: key.into(),
        }),
    )
    .unwrap();
    scripted_copy(server, core)
}

fn scripted_copy(server: &Scripted, core: Core) -> Arc<Core> {
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
                        core.catch_up_until(stop)
                            .map(|_| ())
                            .map_err(|failed| failed.error)
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
                |core, stop| core.catch_up_until(stop).map_err(|failed| failed.error),
            )
            .unwrap_err(),
            CoreError::Canceled,
            "{path}"
        );
        assert_eq!(core.status().unwrap().event_cursor.as_deref(), Some("10"));
    }
}

/// The receipt a create of `id` as `type` is answered with, and the
/// certified read of the row after it.
pub(crate) fn created(id: &str, r#type: &str) -> (String, Answer) {
    let item = serde_json::from_str::<serde_json::Value>(&scripted::item_payload(
        "item.created",
        id,
        r#type,
        1,
    ))
    .unwrap()["item"]
        .clone();
    let current = serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true });
    (
        serde_json::json!({ "item": item }).to_string(),
        scripted::certified(scripted::json(200, &current.to_string())),
    )
}

fn replayed(status: u16, body: &str) -> Answer {
    Answer::Json {
        status,
        body: body.into(),
        headers: vec![("Idempotency-Replayed".into(), "true".into())],
    }
}

fn sent(core: &Core, id: &str) -> bool {
    core.conn()
        .unwrap()
        .query_row("SELECT sent FROM queue WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

/// Stops a drain while the first request to `path` waits, lets that
/// request's answer arrive after the drain has ended, then drains again.
/// The write left in flight must stay sent and unanswered, its late answer
/// dropped, and the next drain must send it again under the same key and
/// take the server's replay.
fn left_in_flight_then_replayed(
    server: &Scripted,
    core: Arc<Core>,
    path: &str,
    row: &str,
    late: &AtomicBool,
) {
    let stop = Arc::new(AtomicBool::new(false));
    let (done, result) = mpsc::channel();
    {
        let (core, stop) = (core.clone(), stop.clone());
        std::thread::spawn(move || {
            let _ = done.send(core.drain_until(&stop));
        });
    }
    server.wait_for(path, 1, WAIT);
    let raised = Instant::now();
    stop.store(true, Ordering::Relaxed);
    let ended = result
        .recv_timeout(WAIT)
        .expect("a stopped drain waited on its write");
    assert!(
        raised.elapsed() < Duration::from_secs(1),
        "a stopped drain waited {:?} on its write",
        raised.elapsed()
    );
    assert_eq!(ended.unwrap_err(), CoreError::Canceled, "{path}");
    let before = core.queue().unwrap();
    let left = before.iter().find(|queued| queued.id == row).unwrap();
    assert_eq!(left.verdict, None, "{path}: {left:?}");
    assert!(
        sent(&core, row),
        "{path}: the write in flight was not kept as sent"
    );
    late.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        core.queue().unwrap(),
        before,
        "{path}: an answer that arrived after the stop was recorded"
    );

    let report = core.drain().unwrap();
    let verdict = report
        .verdicts
        .iter()
        .find(|verdict| verdict.id == row)
        .unwrap_or_else(|| panic!("{path}: {report:?}"));
    assert_eq!(
        verdict.verdict,
        Some(crate::model::Verdict::Accepted),
        "{report:?}"
    );
    let asked = server.seen(path);
    assert_eq!(asked.len(), 2, "{path}");
    // An upload carries no key: the server takes the same bytes as the same
    // blob, and answers it as one it holds.
    if path != "/blobs" {
        assert!(verdict.replayed, "{path}: the replay was not taken as one");
        assert!(asked[0].idempotency_key.is_some(), "{path}");
    }
    assert_eq!(
        asked[0].idempotency_key, asked[1].idempotency_key,
        "{path}: sent again under another key"
    );
    assert_eq!(asked[0].body, asked[1].body, "{path}: sent again changed");
}

#[test]
fn a_stopped_drain_leaves_its_write_in_flight_for_the_next_drain_to_send_again() {
    // A create, and one a natural key names, which is looked up only before
    // its first send.
    for keyed in [false, true] {
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        let mut draft = note(None);
        if keyed {
            draft.source = Some("notes".into());
            draft.source_id = Some("a.md".into());
        }
        let queued = core.create_item(&draft).unwrap();
        let id = queued.item_id.clone().unwrap();
        let (receipt, read) = created(&id, "core.note");
        let late = Arc::new(AtomicBool::new(false));
        server.on(
            "/items",
            vec![
                Answer::WaitFor {
                    ready: late.clone(),
                    answer: Box::new(scripted::json(201, &receipt)),
                },
                replayed(201, &receipt),
            ],
        );
        server.on(&format!("/items/{id}"), vec![read]);
        server.on(
            "/items/lookup",
            vec![scripted::json(200, r#"{"data":[],"tombstones":[]}"#)],
        );
        left_in_flight_then_replayed(&server, core, "/items", &queued.id, &late);
        assert_eq!(
            server.seen("/items/lookup").len(),
            usize::from(keyed),
            "a create already sent was looked up again, and could go out under a new body"
        );
    }

    // An upload, which carries no key: the server takes the same bytes as
    // the same blob.
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in(&server, dir.path());
    holding_a_catalog(&core);
    let file = dir.path().join("bytes.txt");
    std::fs::write(&file, b"hello").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    let blob = format!(r#"{{"hash":"{hash}","size_bytes":5}}"#);
    let late = Arc::new(AtomicBool::new(false));
    server.on(
        "/blobs",
        vec![
            Answer::WaitFor {
                ready: late.clone(),
                answer: Box::new(scripted::json(201, &blob)),
            },
            replayed(200, &blob),
        ],
    );
    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    left_in_flight_then_replayed(&server, core.clone(), "/blobs", &added.upload.id, &late);
    assert_eq!(
        core.queue()
            .unwrap()
            .iter()
            .map(|queued| queued.verdict)
            .collect::<Vec<_>>(),
        [Some(crate::model::Verdict::Accepted); 2],
        "the file item behind the upload was not sent once its bytes were taken"
    );
}

type Queues = dyn Fn(&Core) -> crate::QueuedWrite;

#[test]
fn a_stopped_drain_leaves_a_tag_metadata_or_extension_write_in_flight_for_the_next_drain() {
    let metadata = |replace: bool| {
        move |core: &Core| {
            core.write_metadata(
                "a",
                &crate::MetadataWrite {
                    tags: vec!["y".into()],
                },
                replace,
            )
            .unwrap()
        }
    };
    let (replace, merge) = (metadata(true), metadata(false));
    let add = |core: &Core| core.add_tag("a", "x").unwrap();
    let remove = |core: &Core| core.remove_tag("a", "x").unwrap();
    let write = |core: &Core| core.write_extension("a", "app.cursor", "{}").unwrap();
    let delete = |core: &Core| core.delete_extension("a", "app.cursor").unwrap();
    let tags = r#"{"metadata":{"item_id":"a","tags":["x"],"extensions":{}}}"#;
    let extensions = r#"{"extensions":{"app.cursor":{}}}"#;
    let writes: [(&str, &Queues, &str); 6] = [
        ("/items/a/tags", &add, tags),
        ("/items/a/tags/x", &remove, tags),
        ("/items/a/metadata", &replace, tags),
        ("/items/a/metadata", &merge, tags),
        ("/items/a/extensions/app.cursor", &write, extensions),
        ("/items/a/extensions/app.cursor", &delete, extensions),
    ];
    for (path, queue, answer) in writes {
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        {
            let conn = core.conn().unwrap();
            let held = store::testing::note("a", "a", "", "2026-01-01T00:00:00Z");
            store::upsert_item(&conn, &held, None, &Default::default()).unwrap();
        }
        let row = queue(&core).id;
        let (_, read) = created("a", "core.note");
        server.on("/items/a", vec![read]);
        let late = Arc::new(AtomicBool::new(false));
        server.on(
            path,
            vec![
                Answer::WaitFor {
                    ready: late.clone(),
                    answer: Box::new(scripted::json(200, answer)),
                },
                replayed(200, answer),
            ],
        );
        left_in_flight_then_replayed(&server, core, path, &row, &late);
    }
}

type Stoppable = dyn FnOnce(&Core, &AtomicBool) -> Result<()> + Send;

#[test]
fn a_stop_ends_a_drain_and_a_follow_whose_upload_the_server_never_answers() {
    let upload = |server: &Scripted, dir: &std::path::Path| {
        let core = copy_in(server, dir);
        holding_a_catalog(&core);
        let file = dir.join("bytes.txt");
        std::fs::write(&file, b"hello").unwrap();
        let added = core
            .add_file(&file, &crate::Attachment::default(), &[])
            .unwrap();
        server.on("/blobs", vec![Answer::Stall]);
        (core, added.upload.id)
    };
    let ends_soon = |server: &Scripted, core: Arc<Core>, call: Box<Stoppable>| {
        let stop = Arc::new(AtomicBool::new(false));
        let (done, result) = mpsc::channel();
        {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let _ = done.send(call(&core, &stop));
            });
        }
        server.wait_for("/blobs", 1, Duration::from_secs(10));
        let raised = Instant::now();
        stop.store(true, Ordering::Relaxed);
        let ended = result
            .recv_timeout(WAIT)
            .expect("a stop waited on an upload the server never answers");
        assert!(
            raised.elapsed() < Duration::from_secs(1),
            "a stop waited {:?}",
            raised.elapsed()
        );
        ended
    };

    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (core, row) = upload(&server, dir.path());
    let ended = ends_soon(
        &server,
        core.clone(),
        Box::new(|core, stop| core.drain_until(stop).map(|_| ())),
    );
    assert_eq!(ended, Err(CoreError::Canceled));
    assert!(sent(&core, &row));

    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (core, row) = upload(&server, dir.path());
    server.on(
        "/events",
        vec![
            scripted::refusal(503, "unavailable"),
            scripted::stream(
                vec![scripted::connected()],
                Then::Hold {
                    keepalive: Some(Duration::from_millis(50)),
                    lasting: None,
                },
            ),
        ],
    );
    let ended = ends_soon(
        &server,
        core.clone(),
        Box::new(|core, stop| core.follow(stop, false, |_| {}).map(|_| ())),
    );
    assert_eq!(ended, Ok(()));
    assert!(sent(&core, &row));
    assert_eq!(core.queue().unwrap()[0].verdict, None);
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
            .map(|_| ())
            .map_err(|failed| failed.error)),
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
        crate::catch_up::ask_unless_stopped(&stop, &http, crate::http::Http::catalog)
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
