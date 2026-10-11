use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use crate::http::{Call, CallBody, Http, Method, Outgoing};
use crate::scripted::{self, Answer, Scripted, Then};
use crate::{Core, CoreError, Server, store};

const OLD_ORIGIN: &str = "http://127.0.0.1:8";
const OTHER_INSTANCE: &str = "00000000-0000-7000-8000-000000000001";

fn moving_copy(url: &str, identity: Option<&str>) -> (tempfile::TempDir, Core) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    let core = Core::open(&path, None).unwrap();
    core.create_item(&crate::stop_tests::note(None)).unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SERVER_ORIGIN, OLD_ORIGIN).unwrap();
        if let Some(identity) = identity {
            store::meta_set(&conn, store::META_INSTANCE_ID, identity).unwrap();
        }
    }
    drop(core);
    let core = Core::open(
        &path,
        Some(Server {
            url: url.into(),
            key: "held-key".into(),
        }),
    )
    .unwrap();
    (dir, core)
}

fn origin(core: &Core) -> String {
    store::meta_get(&core.conn().unwrap(), store::META_SERVER_ORIGIN)
        .unwrap()
        .unwrap()
}

fn ask(http: &Http, door: usize) -> crate::Result<()> {
    match door {
        0 => http.types().map(|_| ()),
        1 => http
            .send(&Outgoing {
                method: Method::Post,
                segments: vec!["items".into()],
                params: vec![],
                body: "{}",
                idempotency_key: "kept-write",
            })
            .map(|_| ()),
        2 => http.open_events(None, Duration::from_secs(1)).map(|_| ()),
        3..=6 => http
            .fetch(
                Call {
                    method: if door == 3 || door == 5 {
                        Method::Post
                    } else {
                        Method::Get
                    },
                    segments: &["items"],
                    params: &[],
                    headers: &[],
                    body: match door {
                        3 => CallBody::Json("{}"),
                        5 => CallBody::Reader(Box::new(std::io::Cursor::new(b"file"))),
                        _ => CallBody::None,
                    },
                    credential: door != 6,
                    stream: door == 4,
                },
                true,
            )
            .map(|_| ()),
        7 => http.for_view(scripted::FENCE).types().map(|_| ()),
        8 => http.to_let_go().clone().types().map(|_| ()),
        _ => unreachable!(),
    }
}

fn doors(server: &Scripted) {
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    server.on("/items", vec![scripted::json(200, "{}")]);
    server.on("/events", vec![scripted::stream(vec![], Then::End)]);
}

#[test]
fn relocation_opens_offline_and_keeps_the_recorded_origin_until_confirmed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("copy.sqlite");
    let core = Core::open(&path, None).unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SERVER_ORIGIN, "http://127.0.0.1:8").unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
    }
    drop(core);
    let moved = Core::open(
        &path,
        Some(Server {
            url: "http://127.0.0.1:9".into(),
            key: "held-key".into(),
        }),
    )
    .unwrap();
    assert_eq!(
        store::meta_get(&moved.conn().unwrap(), store::META_SERVER_ORIGIN)
            .unwrap()
            .as_deref(),
        Some("http://127.0.0.1:8")
    );
}

#[test]
fn relocation_gates_every_transport_door_and_clone_with_an_anonymous_identity() {
    let server = Scripted::start();
    doors(&server);
    server.on("/", vec![scripted::root(OTHER_INSTANCE)]);
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let before = core.queue().unwrap();
    let http = core.http().unwrap();
    for door in 0..9 {
        assert!(
            matches!(ask(http, door), Err(CoreError::WrongServer { .. })),
            "door {door}"
        );
        assert_eq!(origin(&core), OLD_ORIGIN);
    }
    assert_eq!(server.asked(), 9);
    for request in server.seen("/") {
        assert_eq!(request.authorization, None);
        assert_eq!(request.read_view, None);
        assert!(request.body.is_empty());
    }
    assert_eq!(core.queue().unwrap(), before);
    // The same doors send once the identity agrees, including the public call.
    server.on("/", vec![scripted::root(scripted::INSTANCE)]);
    for door in 0..9 {
        ask(http, door).unwrap();
    }
    assert_eq!(server.seen("/").len(), 10);
    assert_eq!(server.seen("/types").len(), 3);
    assert_eq!(server.seen("/items").len(), 5);
    assert_eq!(server.seen("/events").len(), 1);
    assert_eq!(origin(&core), server.url());
    assert_eq!(core.queue().unwrap(), before);
    assert!(
        server
            .seen("/items")
            .iter()
            .any(|request| request.authorization.as_deref() == Some("Bearer held-key"))
    );
    assert!(
        server
            .seen("/items")
            .iter()
            .any(|request| request.authorization.is_none())
    );
}

#[test]
fn relocation_refused_or_malformed_identity_never_renews_or_sends_credentials() {
    let roots = [
        scripted::root(OTHER_INSTANCE),
        scripted::json(200, "{}"),
        scripted::json(200, r#"{"instance_id":""}"#),
        scripted::refusal(401, "unauthorized"),
        scripted::refusal(503, "unavailable"),
        Answer::Json {
            status: 302,
            body: "{}".into(),
            headers: vec![("Location".into(), "http://127.0.0.1:9".into())],
        },
    ];
    for root in roots {
        let server = Scripted::start();
        doors(&server);
        server.on("/", vec![root]);
        let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
        let before = core.queue().unwrap();
        let renewals = Arc::new(AtomicUsize::new(0));
        let renewed = renewals.clone();
        core.renew_credential_with(Box::new(move |_| {
            renewed.fetch_add(1, Ordering::SeqCst);
            Ok("fresh".into())
        }));
        for door in 0..9 {
            assert!(ask(core.http().unwrap(), door).is_err(), "door {door}");
        }
        assert_eq!(renewals.load(Ordering::SeqCst), 0);
        assert_eq!(server.asked(), 9);
        assert!(
            server
                .seen("/")
                .iter()
                .all(|request| request.authorization.is_none() && request.read_view.is_none())
        );
        assert_eq!(origin(&core), OLD_ORIGIN);
        assert_eq!(core.queue().unwrap(), before);
        // A temporary failure is not remembered as a permanent refusal.
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        server.on(
            "/types",
            vec![
                scripted::refusal(401, "unauthorized"),
                scripted::types(&[("core.note", None)]),
            ],
        );
        core.http().unwrap().types().unwrap();
        assert_eq!(renewals.load(Ordering::SeqCst), 1);
        assert_eq!(origin(&core), server.url());
    }
}

#[test]
fn relocation_without_a_recorded_identity_refuses_before_contact_and_a_new_copy_can_send() {
    let server = Scripted::start();
    doors(&server);
    let (_dir, core) = moving_copy(&server.url(), None);
    for door in 0..9 {
        assert!(matches!(
            ask(core.http().unwrap(), door),
            Err(CoreError::WrongServer { .. })
        ));
    }
    assert_eq!(server.asked(), 0);
    assert_eq!(origin(&core), OLD_ORIGIN);
    let fresh = Core::open_in_memory(Some(Server {
        url: server.url(),
        key: "new-key".into(),
    }))
    .unwrap();
    fresh.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/types").len(), 1);
}

#[test]
fn relocation_commits_before_credentials_and_can_retry_a_failed_commit() {
    let server = Scripted::start();
    doors(&server);
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    core.conn().unwrap().commit_hook(Some(|| true)).unwrap();
    assert!(matches!(
        core.http().unwrap().types(),
        Err(CoreError::Store(_))
    ));
    assert_eq!(server.asked(), 1);
    assert_eq!(origin(&core), OLD_ORIGIN);
    core.conn()
        .unwrap()
        .commit_hook(None::<fn() -> bool>)
        .unwrap();
    core.http().unwrap().types().unwrap();
    assert_eq!(origin(&core), server.url());
    assert_eq!(server.seen("/types").len(), 1);
}

#[test]
fn relocation_verifies_once_for_concurrent_clones_and_reopens_at_the_verified_origin() {
    let server = Scripted::start();
    doors(&server);
    server.on(
        "/",
        vec![Answer::Slow {
            after: Duration::from_millis(100),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    let (dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let http = core.http().unwrap().clone();
            scope.spawn(move || http.types().unwrap());
        }
    });
    assert_eq!(server.seen("/").len(), 1);
    assert_eq!(server.seen("/types").len(), 8);
    drop(core);
    let reopened = Core::open(
        dir.path().join("copy.sqlite"),
        Some(Server {
            url: server.url(),
            key: "reopened-key".into(),
        }),
    )
    .unwrap();
    reopened.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/").len(), 1);
    assert_eq!(
        server
            .seen("/types")
            .last()
            .unwrap()
            .authorization
            .as_deref(),
        Some("Bearer reopened-key")
    );
}

#[test]
fn relocation_cancellation_keeps_the_old_origin_and_the_next_attempt_can_confirm() {
    let server = Scripted::start();
    doors(&server);
    let released = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![
            Answer::WaitFor {
                ready: released.clone(),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            },
            scripted::root(scripted::INSTANCE),
        ],
    );
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let http = core.http().unwrap().to_let_go();
    let asked = http.clone();
    let worker = std::thread::spawn(move || asked.types());
    server.wait_for("/", 1, Duration::from_secs(2));
    http.let_go();
    released.store(true, Ordering::SeqCst);
    assert!(matches!(worker.join().unwrap(), Err(CoreError::Canceled)));
    assert!(server.seen("/types").is_empty());
    assert_eq!(origin(&core), OLD_ORIGIN);
    core.http().unwrap().types().unwrap();
    assert_eq!(origin(&core), server.url());
    assert_eq!(server.seen("/types").len(), 1);
}

#[test]
fn relocation_rechecks_identity_when_it_records_the_origin() {
    let server = Scripted::start();
    doors(&server);
    let released = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![
            Answer::WaitFor {
                ready: released.clone(),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            },
            scripted::root(scripted::INSTANCE),
        ],
    );
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let asked = core.http().unwrap().clone();
    let worker = std::thread::spawn(move || asked.types());
    server.wait_for("/", 1, Duration::from_secs(2));
    store::meta_set(
        &core.conn().unwrap(),
        store::META_INSTANCE_ID,
        "new-local-instance",
    )
    .unwrap();
    released.store(true, Ordering::SeqCst);
    assert!(matches!(
        worker.join().unwrap(),
        Err(CoreError::WrongServer { .. })
    ));
    assert_eq!(origin(&core), OLD_ORIGIN);
    assert!(server.seen("/types").is_empty());
    store::meta_set(
        &core.conn().unwrap(),
        store::META_INSTANCE_ID,
        scripted::INSTANCE,
    )
    .unwrap();
    core.http().unwrap().types().unwrap();
    assert_eq!(origin(&core), server.url());
}

#[test]
fn relocation_http_clone_keeps_writer_ownership_until_confirmation_ends() {
    let server = Scripted::start();
    doors(&server);
    let released = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![Answer::WaitFor {
            ready: released.clone(),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    let (dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let path = dir.path().join("copy.sqlite");
    let asked = core.http().unwrap().clone();
    let worker = std::thread::spawn(move || asked.types());
    server.wait_for("/", 1, Duration::from_secs(2));
    drop(core);
    let reader = Core::open(&path, None).unwrap();
    assert_eq!(reader.handle(), crate::Handle::Reader);
    released.store(true, Ordering::SeqCst);
    worker.join().unwrap().unwrap();
    assert_eq!(origin(&reader), server.url());
    drop(reader);
    assert_eq!(
        Core::open(&path, None).unwrap().handle(),
        crate::Handle::Writer
    );
}

#[test]
fn relocation_reader_cannot_commit_a_verified_origin_or_send_credentials() {
    let server = Scripted::start();
    doors(&server);
    let (dir, writer) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let reader = Core::open(
        dir.path().join("copy.sqlite"),
        Some(Server {
            url: server.url(),
            key: "reader-key".into(),
        }),
    )
    .unwrap();
    assert_eq!(reader.handle(), crate::Handle::Reader);
    assert!(matches!(
        reader.http().unwrap().types(),
        Err(CoreError::ReadingHandle)
    ));
    assert_eq!(server.asked(), 1);
    assert_eq!(server.seen("/")[0].authorization, None);
    assert_eq!(origin(&writer), OLD_ORIGIN);
    // The writer that owns the copy can commit the same confirmation.
    writer.http().unwrap().types().unwrap();
    assert_eq!(origin(&writer), server.url());
    assert_eq!(
        server.seen("/types")[0].authorization.as_deref(),
        Some("Bearer held-key")
    );
}

#[test]
fn relocation_identity_reads_strip_url_credentials() {
    let server = Scripted::start();
    doors(&server);
    let url = server.url().replacen("http://", "http://user:password@", 1);
    let (_dir, core) = moving_copy(&url, Some(scripted::INSTANCE));
    core.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/")[0].authorization, None);
    assert_eq!(
        server.seen("/types")[0].authorization.as_deref(),
        Some("Bearer held-key")
    );
    assert_eq!(origin(&core), server.url());
}

#[test]
fn relocation_unreachable_origin_keeps_unsent_work_and_can_be_opened_again() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (dir, core) = moving_copy(&url, Some(scripted::INSTANCE));
    let queue = core.queue().unwrap();
    assert!(matches!(
        core.http().unwrap().types(),
        Err(CoreError::Network(_))
    ));
    assert_eq!(core.queue().unwrap(), queue);
    assert_eq!(origin(&core), OLD_ORIGIN);
    drop(core);
    let reopened = Core::open(dir.path().join("copy.sqlite"), None).unwrap();
    assert_eq!(reopened.handle(), crate::Handle::Writer);
    assert_eq!(reopened.queue().unwrap(), queue);
}

#[test]
fn relocation_can_cancel_while_waiting_for_the_database_without_committing_later() {
    let server = Scripted::start();
    doors(&server);
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let held = core.conn().unwrap();
    let http = core.http().unwrap().to_let_go();
    let asked = http.clone();
    let worker = std::thread::spawn(move || asked.types());
    server.wait_for("/", 1, Duration::from_secs(2));
    http.let_go();
    assert!(matches!(worker.join().unwrap(), Err(CoreError::Canceled)));
    assert_eq!(
        store::meta_get(&held, store::META_SERVER_ORIGIN)
            .unwrap()
            .as_deref(),
        Some(OLD_ORIGIN)
    );
    drop(held);
    assert!(server.seen("/types").is_empty());
    core.http().unwrap().types().unwrap();
    assert_eq!(origin(&core), server.url());
}

#[test]
fn relocation_can_cancel_a_waiter_while_another_clone_confirms() {
    let server = Scripted::start();
    doors(&server);
    let released = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![Answer::WaitFor {
            ready: released.clone(),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    let first = core.http().unwrap().clone();
    let confirming = std::thread::spawn(move || first.types());
    server.wait_for("/", 1, Duration::from_secs(2));
    let waiter = core.http().unwrap().to_let_go();
    let asked = waiter.clone();
    let waiting = std::thread::spawn(move || asked.types());
    waiter.let_go();
    assert!(matches!(waiting.join().unwrap(), Err(CoreError::Canceled)));
    assert_eq!(origin(&core), OLD_ORIGIN);
    released.store(true, Ordering::SeqCst);
    confirming.join().unwrap().unwrap();
    assert_eq!(server.seen("/").len(), 1);
    assert_eq!(server.seen("/types").len(), 1);
    assert_eq!(origin(&core), server.url());
}

fn current_copy(core: &Core) {
    let conn = core.conn().unwrap();
    store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
    store::meta_set(&conn, crate::read_view::FENCE, scripted::FENCE).unwrap();
    store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
    store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
}

#[test]
fn relocation_wrong_server_preserves_self_clearing_queue_verdicts() {
    let server = Scripted::start();
    server.on("/", vec![scripted::root(OTHER_INSTANCE)]);
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    current_copy(&core);
    for reason in [
        crate::BlockedReason::CredentialRefused,
        crate::BlockedReason::AwaitingDependency,
    ] {
        store::block_unanswered(&core.conn().unwrap(), reason).unwrap();
        let before = core.queue().unwrap();
        assert!(matches!(core.drain(), Err(CoreError::WrongServer { .. })));
        assert_eq!(core.queue().unwrap(), before);
        assert_eq!(origin(&core), OLD_ORIGIN);
        core.conn()
            .unwrap()
            .execute(
                "UPDATE queue SET verdict = NULL, reason = NULL, answered_at = NULL",
                [],
            )
            .unwrap();
    }
    assert_eq!(server.asked(), 2);
    assert!(
        server
            .seen("/")
            .iter()
            .all(|seen| seen.authorization.is_none())
    );
}

#[test]
fn relocation_follow_cancellation_stops_the_abandoned_identity_probe() {
    let server = Scripted::start();
    doors(&server);
    let released = Arc::new(AtomicBool::new(false));
    let retried = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![
            Answer::WaitFor {
                ready: released.clone(),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            },
            Answer::WaitFor {
                ready: retried.clone(),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            },
        ],
    );
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    current_copy(&core);
    let before = core.queue().unwrap();
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let following = scope.spawn(|| core.follow(&stop, false, |_| {}));
        server.wait_for("/", 1, Duration::from_secs(2));
        stop.store(true, Ordering::SeqCst);
        following.join().unwrap().unwrap();
    });
    assert_eq!(origin(&core), OLD_ORIGIN);
    assert_eq!(core.queue().unwrap(), before);
    released.store(true, Ordering::SeqCst);
    // A retry waits for the abandoned worker's gate. It must perform its own
    // anonymous verification rather than inherit that worker's admission.
    let retry = core.http().unwrap().clone();
    let retrying = std::thread::spawn(move || retry.types());
    server.wait_for("/", 2, Duration::from_secs(2));
    assert_eq!(origin(&core), OLD_ORIGIN);
    assert_eq!(core.queue().unwrap(), before);
    assert!(server.seen("/types").is_empty());
    retried.store(true, Ordering::SeqCst);
    retrying.join().unwrap().unwrap();
    assert_eq!(server.seen("/").len(), 2);
    assert_eq!(server.seen("/types").len(), 1);
    assert!(server.seen("/edge-types").is_empty());
    assert!(server.seen("/events").is_empty());
    assert_eq!(core.queue().unwrap(), before);
    assert_eq!(origin(&core), server.url());
}

#[test]
fn relocation_unavailable_server_preserves_blocked_queue_and_empty_pass_is_offline() {
    let server = Scripted::start();
    server.on("/", vec![scripted::json(503, "{}")]);
    let (_dir, core) = moving_copy(&server.url(), Some(scripted::INSTANCE));
    current_copy(&core);
    store::block_unanswered(
        &core.conn().unwrap(),
        crate::BlockedReason::CredentialRefused,
    )
    .unwrap();
    let before = core.queue().unwrap();
    let report = core.drain().unwrap();
    assert!(report.unavailable.is_some());
    assert_eq!(report.undelivered, before.len());
    assert_eq!(core.queue().unwrap(), before);
    assert_eq!(origin(&core), OLD_ORIGIN);
    assert_eq!(server.asked(), 1);
    core.conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
    core.drain().unwrap();
    assert_eq!(server.asked(), 1);
    assert_eq!(origin(&core), OLD_ORIGIN);
}
