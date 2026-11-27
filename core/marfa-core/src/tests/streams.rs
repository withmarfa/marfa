use super::*;

#[test]
fn server_calls_need_a_server_and_catch_up_needs_a_cursor() {
    let offline = Core::open_in_memory(None).unwrap();
    assert_eq!(
        offline.hydrate(&["core.note".into()], SliceTier::Library),
        Err(CoreError::NoServer)
    );
    assert_eq!(offline.catch_up(), Err(CoreError::NoServer));
    let fresh = Core::open_in_memory(unreachable_server("http://127.0.0.1:9")).unwrap();
    assert_eq!(fresh.catch_up(), Err(CoreError::NoCursor));
    assert!(matches!(
        fresh.hydrate(&[], SliceTier::Library),
        Err(CoreError::Invalid(_))
    ));
    assert!(matches!(
        fresh.hydrate(&["*".into(), "core.note".into()], SliceTier::Library),
        Err(CoreError::Invalid(_))
    ));
}

#[test]
fn one_stream_at_a_time_moves_the_cursor() {
    let dir = tempfile::tempdir().unwrap();
    // Nothing answers here, so the follow asks again until it is stopped.
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: "http://127.0.0.1:9".into(),
            key: "k".into(),
        }),
    )
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let following = scope.spawn(|| core.follow(&stop, false, |_| {}));
        std::thread::sleep(Duration::from_millis(300));
        let second = core.catch_up();
        let hydrating = core.hydrate(&["core.note".into()], SliceTier::Library);
        stop.store(true, Ordering::Relaxed);
        let report = following.join().unwrap().unwrap();
        assert!(
            matches!(&second, Err(CoreError::Invalid(message)) if message.contains("already")),
            "a catch-up ran beside a follow on one handle: {second:?}"
        );
        assert!(
            matches!(&hydrating, Err(CoreError::Invalid(message)) if message.contains("already")),
            "a hydration ran under a follow, which goes on applying events to the copy it replaces: {hydrating:?}"
        );
        assert!(report.failed_opens >= 1, "{report:?}");
    });
    assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
}

#[test]
fn no_stream_runs_across_a_hydration() {
    let server = crate::scripted::Scripted::start();
    // The hydration's first read, the log's head, is never answered.
    server.on("/events", vec![scripted::Answer::Stall]);
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    std::thread::scope(|scope| {
        let hydrating = scope.spawn(|| core.hydrate(&["core.note".into()], SliceTier::Library));
        server.wait_for("/events", 1, Duration::from_secs(5));
        let caught = core.catch_up();
        let followed = core.follow(&AtomicBool::new(false), false, |_| {});
        for (what, refused) in [("catch-up", caught.err()), ("follow", followed.err())] {
            assert!(
                matches!(&refused, Some(CoreError::Invalid(message)) if message.contains("already")),
                "a {what} ran across a hydration: {refused:?}"
            );
        }
        drop(server);
        assert!(hydrating.join().unwrap().is_err());
    });
    assert!(!matches!(core.catch_up(), Err(CoreError::Invalid(_))));
}

#[test]
fn claims_made_at_once_never_both_win() {
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};
    let core = Core::open_in_memory(None).unwrap();
    let holding = AtomicUsize::new(0);
    let (won, overlapped) = (AtomicUsize::new(0), AtomicBool::new(false));
    let hold = |claim: crate::streams::StreamClaim<'_>| {
        won.fetch_add(1, Ordering::SeqCst);
        if holding.fetch_add(1, Ordering::SeqCst) > 0 {
            overlapped.store(true, Ordering::SeqCst);
        }
        std::thread::yield_now();
        holding.fetch_sub(1, Ordering::SeqCst);
        drop(claim);
    };
    for _ in 0..300 {
        let (go, stop, ended) = (
            AtomicBool::new(false),
            AtomicBool::new(false),
            AtomicUsize::new(0),
        );
        std::thread::scope(|scope| {
            for at in 0..8 {
                let (core, go, stop, ended, hold) = (&core, &go, &stop, &ended, &hold);
                scope.spawn(move || {
                    while !go.load(Ordering::Acquire) {
                        std::hint::spin_loop();
                    }
                    match at % 3 {
                        0 => {
                            if let Ok(claim) = core.try_claim_stream(Mover::Fill) {
                                hold(claim);
                            }
                        }
                        1 => {
                            if let Ok(Some(claim)) = core.claim_stream_waiting(Mover::CatchUp, stop)
                            {
                                hold(claim);
                            }
                        }
                        _ => {
                            if let Ok(claim) = core.claim_stream(Mover::CatchUp) {
                                hold(claim);
                            }
                        }
                    }
                    ended.fetch_add(1, Ordering::SeqCst);
                });
            }
            go.store(true, Ordering::Release);
            let started = Instant::now();
            while ended.load(Ordering::SeqCst) < 8 && started.elapsed() < Duration::from_millis(50)
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            stop.store(true, Ordering::SeqCst);
        });
    }
    assert!(won.load(Ordering::SeqCst) >= 300);
    assert!(
        !overlapped.load(Ordering::SeqCst),
        "two claims were held at once, so two streams could move one cursor"
    );
}
