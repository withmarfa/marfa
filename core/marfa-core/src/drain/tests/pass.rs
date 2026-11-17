use super::*;

#[test]
fn a_read_reconciling_a_refusal_refused_naming_no_contract_ends_the_pass() {
    let server = crate::scripted::Scripted::start();
    let rows = ["a", "b"];
    // `a` is refused and read back; the read meets a proxy, so `b` waits.
    server.on(
        "/items/a",
        vec![
            crate::scripted::refusal(400, "invalid"),
            crate::scripted::unnamed(400, "bad_request"),
        ],
    );
    server.on(
        "/items/b",
        vec![crate::scripted::json(200, r#"{"ok":true}"#)],
    );
    let (_dir, core) = deleting(&server, &rows);
    let report = core.drain().unwrap();
    assert_eq!(
        server.seen("/items/b").len(),
        0,
        "the pass went on past a read something in front of the server refused"
    );
    assert!(
        report
            .unavailable
            .as_deref()
            .is_some_and(|why| why.contains("naming no contract")),
        "{report:?}"
    );
    assert_eq!((report.answered, report.undelivered), (1, 1));
}

#[test]
fn drains_at_once_send_each_write_once_and_count_only_their_own() {
    let server = crate::scripted::Scripted::start();
    let rows = ["a", "b", "c"];
    for id in rows {
        server.on(
            &format!("/items/{id}"),
            vec![
                crate::scripted::Answer::Slow {
                    after: std::time::Duration::from_millis(150),
                    answer: Box::new(crate::scripted::json(200, r#"{"ok":true}"#)),
                },
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
    }
    server.on("/items", vec![in_the_bin(&[("a", 1), ("b", 1), ("c", 1)])]);
    let (_dir, core) = deleting(&server, &rows);

    let answered: Vec<usize> = std::thread::scope(|scope| {
        let drains: Vec<_> = (0..3)
            .map(|_| scope.spawn(|| core.drain().unwrap().answered))
            .collect();
        drains
            .into_iter()
            .map(|drain| drain.join().unwrap())
            .collect()
    });

    let sent: Vec<usize> = rows
        .iter()
        .map(|id| server.seen(&format!("/items/{id}")).len())
        .collect();
    assert_eq!(
        sent,
        [2, 2, 2],
        "each write needs one original receipt and one fresh read"
    );
    assert_eq!(
        answered.iter().sum::<usize>(),
        3,
        "the drains counted writes another drain had answered: {answered:?}"
    );
    for id in rows {
        held_in_the_bin(&core, id, 1);
    }
}

#[test]
fn a_pass_ends_at_the_first_write_the_server_cannot_take() {
    for (cannot, says) in [
        (crate::scripted::refusal(503, "unavailable"), "503"),
        (
            crate::scripted::refusal(429, "rate_limited"),
            "the server is limiting requests (429)",
        ),
        (
            crate::scripted::Answer::Stall,
            "request to http://127.0.0.1:",
        ),
    ] {
        let server = crate::scripted::Scripted::start();
        let rows = ["a", "b", "c"];
        server.on("/items/a", vec![cannot]);
        for id in &rows[1..] {
            server.on(
                &format!("/items/{id}"),
                vec![crate::scripted::json(200, r#"{"ok":true}"#)],
            );
        }
        let (_dir, core) = deleting(&server, &rows);
        if says.starts_with("request to") {
            // Gone rather than waited out: a refused connection.
            drop(server);
            let report = core.drain().unwrap();
            assert!(
                report
                    .unavailable
                    .as_deref()
                    .is_some_and(|why| why.contains(says)),
                "{report:?}"
            );
            assert_eq!((report.answered, report.undelivered), (0, 3));
            continue;
        }
        let report = core.drain().unwrap();
        assert_eq!(
            (server.seen("/items/b").len(), server.seen("/items/c").len()),
            (0, 0),
            "the pass went on to the writes behind one the server could not take"
        );
        assert_eq!((report.answered, report.undelivered), (0, 3));
        assert!(
            report
                .unavailable
                .as_deref()
                .is_some_and(|why| why.contains(says)),
            "{report:?}"
        );
        assert!(
            core.queue()
                .unwrap()
                .iter()
                .all(|row| row.verdict.is_none() && row.refusals == 0),
            "a write left behind was answered or counted"
        );
    }
}

#[test]
fn local_renewal_failure_preserves_queued_intent_without_counting() {
    for error in [
        CoreError::SignedOut {
            origin: "https://marfa.example".into(),
        },
        CoreError::NoKeychain("locked".into()),
        CoreError::Invalid("unsafe credential lock".into()),
        CoreError::Decoding("malformed token".into()),
        CoreError::Redirected {
            origin: "https://marfa.example".into(),
            status: 302,
            location: Some("/elsewhere".into()),
        },
        CoreError::Server {
            status: 400,
            code: "invalid_scope".into(),
            message: "refused scope".into(),
            details: None,
        },
        CoreError::Server {
            status: 400,
            code: "invalid_scope".into(),
            message: "refused scope".into(),
            details: Some(Box::new(
                serde_json::json!({ "required_scope": "items.read" }),
            )),
        },
    ] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &["first", "later"]);
        server.on(
            "/items/first",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        let expected = error.clone();
        core.renew_credential_with(Box::new(move |_| Err(error.clone())));
        let before = core.queue().unwrap();
        let payloads: Vec<_> = before
            .iter()
            .map(|row| store::payload_of(&core.conn().unwrap(), &row.id).unwrap())
            .collect();
        assert_eq!(
            core.drain().unwrap_err(),
            CoreError::RenewalFailed(Box::new(expected))
        );
        let after = core.queue().unwrap();
        assert_eq!(before, after);
        for (row, payload) in after.iter().zip(payloads) {
            assert_eq!(
                store::payload_of(&core.conn().unwrap(), &row.id).unwrap(),
                payload
            );
            assert_eq!(row.refusals, 0);
            assert_eq!(row.verdict, None);
        }
        assert!(server.seen("/items/later").is_empty());
    }
}

#[test]
fn renewal_after_an_answer_preserves_progress_and_current_intent() {
    for environmental in [false, true] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &["prior", "current", "later"]);
        server.on(
            "/items/prior",
            vec![
                crate::scripted::json(200, r#"{"ok":true}"#),
                crate::scripted::certified(crate::scripted::refusal(404, "item_not_found")),
            ],
        );
        server.on("/items", vec![in_the_bin(&[("prior", 1)])]);
        server.on(
            "/items/current",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        let error = if environmental {
            CoreError::StorageFull("fixture disk full".into())
        } else {
            CoreError::SignedOut {
                origin: server.url(),
            }
        };
        let expected = error.clone();
        core.renew_credential_with(Box::new(move |_| Err(error.clone())));
        let before = core.queue().unwrap();
        let payloads: Vec<_> = before
            .iter()
            .map(|row| store::payload_of(&core.conn().unwrap(), &row.id).unwrap())
            .collect();
        if environmental {
            let report = core.drain().unwrap();
            assert_eq!((report.answered, report.undelivered), (1, 2));
            assert!(report.unavailable.is_some());
            assert!(report.stopped.is_none());
            assert_eq!(report.verdicts[0].verdict, Some(Verdict::Accepted));
        } else {
            assert_eq!(
                core.drain().unwrap_err(),
                CoreError::RenewalFailed(Box::new(expected))
            );
        }
        let after = core.queue().unwrap();
        assert_eq!(after[0].verdict, Some(Verdict::Accepted));
        assert!(after[0].answered_at.is_some());
        held_in_the_bin(&core, "prior", 1);
        assert_eq!(after[1..], before[1..]);
        for (row, payload) in after.iter().zip(payloads).skip(1) {
            assert_eq!(
                store::payload_of(&core.conn().unwrap(), &row.id).unwrap(),
                payload
            );
            assert_eq!(row.refusals, 0);
            assert!(row.verdict.is_none());
        }
        assert_eq!(server.seen("/items/current").len(), 1);
        assert!(server.seen("/items/later").is_empty());
    }
}

#[test]
fn rate_limited_renewal_reports_its_wait_without_counting_the_write() {
    for (requested, expected) in [
        (Some(120), Some(120)),
        (Some(86_400), Some(300)),
        (None, None),
    ] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = deleting(&server, &["current", "later"]);
        server.on(
            "/items/current",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        core.renew_credential_with(Box::new(move |_| {
            Err(CoreError::RateLimited {
                code: "rate_limited".into(),
                message: "wait before renewing".into(),
                retry_after_seconds: requested,
                details: None,
            })
        }));
        let before = core.queue().unwrap();
        let payload = store::payload_of(&core.conn().unwrap(), &before[0].id).unwrap();
        let report = core.drain().unwrap();
        assert_eq!(report.retry_after_seconds, expected);
        assert_eq!((report.answered, report.undelivered), (0, 2));
        assert!(report.unavailable.is_some());
        assert!(report.stopped.is_none());
        assert_eq!(core.queue().unwrap(), before);
        assert_eq!(
            store::payload_of(&core.conn().unwrap(), &before[0].id).unwrap(),
            payload
        );
        assert!(
            report
                .verdicts
                .iter()
                .all(|row| row.verdict.is_none() && row.refusals == 0)
        );
        assert!(server.seen("/items/later").is_empty());
    }
}

fn answered_with(status: u16, code: &str, wait: &str) -> crate::scripted::Answer {
    crate::scripted::Answer::Json {
        status,
        body: format!(r#"{{"error":{{"code":"{code}","message":"wait"}}}}"#),
        headers: vec![("Retry-After".into(), wait.into())],
    }
}

#[test]
fn a_wait_named_without_a_429_is_not_the_server_limiting_requests() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["current", "later"]);
    server.on(
        "/items/current",
        vec![answered_with(503, "service_unavailable", "30")],
    );
    let report = core.drain().unwrap();
    assert_eq!(report.retry_after_seconds, Some(30));
    assert!(!report.limited, "{report:?}");
    let unavailable = report.unavailable.unwrap();
    assert!(!unavailable.contains("limiting"), "{unavailable}");
}

#[test]
fn a_429_asking_for_longer_than_the_cap_says_the_capped_wait() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["current", "later"]);
    server.on(
        "/items/current",
        vec![answered_with(429, "rate_limited", "600")],
    );
    let report = core.drain().unwrap();
    assert_eq!(report.retry_after_seconds, Some(300));
    assert!(report.limited);
    assert_eq!(
        report.unavailable.as_deref(),
        Some("the server is limiting requests (429) and asked for a wait of 300s")
    );
    assert_eq!((report.answered, report.undelivered), (0, 2));
}

#[test]
fn a_429_naming_no_contract_blames_what_is_in_front_and_is_not_a_limit() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["current", "later"]);
    server.on(
        "/items/current",
        vec![crate::scripted::unnamed(429, "rate_limited")],
    );
    let report = core.drain().unwrap();
    assert!(!report.limited, "{report:?}");
    let unavailable = report.unavailable.unwrap();
    assert!(unavailable.contains("naming no contract"), "{unavailable}");
    assert!(!unavailable.contains("limiting"), "{unavailable}");
}

#[test]
fn a_429_on_the_instance_check_is_the_server_limiting_requests() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &["current", "later"]);
    server.on("/", vec![answered_with(429, "rate_limited", "45")]);
    let report = core.drain().unwrap();
    assert!(report.limited, "{report:?}");
    assert_eq!(report.retry_after_seconds, Some(45));
    assert_eq!(
        report.unavailable.as_deref(),
        Some("the server is limiting requests (429) and asked for a wait of 45s")
    );
    assert!(server.seen("/items/current").is_empty());
}

#[test]
fn a_refused_renewal_parks_the_queue_and_one_the_network_stopped_waits() {
    let refused = |renewal: CoreError| {
        let server = crate::scripted::Scripted::start();
        server.on(
            "/blobs",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        let renewal = std::sync::Mutex::new(Some(renewal));
        http.renew_with(Box::new(move |_| {
            Err(renewal.lock().unwrap().take().expect("renewed once"))
        }));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bytes");
        std::fs::write(&path, b"hello").unwrap();
        classify(&upload(&http, File::open(&path).unwrap(), "text/plain"))
    };

    assert_eq!(
        refused(CoreError::Unauthorized {
            server: None,
            code: "signed_out".into(),
            message: "the sign-in ended".into(),
        }),
        Classified::BlockQueue(BlockedReason::CredentialRefused)
    );
    assert_eq!(
        refused(CoreError::Network(
            "the token endpoint did not answer".into()
        )),
        Classified::Environmental
    );
}

#[test]
fn an_upload_refused_for_its_token_is_sent_again_whole_under_a_renewed_one() {
    let server = crate::scripted::Scripted::start();
    server.on(
        "/blobs",
        vec![
            crate::scripted::refusal(401, "unauthorized"),
            crate::scripted::json(201, r#"{"hash":"sha256:00","size_bytes":5}"#),
        ],
    );
    let http = Http::new(&server.url(), "k").unwrap();
    http.renew_with(Box::new(|_| Ok("fresh".into())));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bytes");
    std::fs::write(&path, b"hello").unwrap();

    let answer = upload(&http, File::open(&path).unwrap(), "text/plain").unwrap();

    assert_eq!(answer.status, 201);
    let sent: Vec<_> = server
        .seen("/blobs")
        .into_iter()
        .map(|seen| (seen.authorization, seen.body))
        .collect();
    assert_eq!(
        sent,
        vec![
            (Some("Bearer k".into()), b"hello".to_vec()),
            (Some("Bearer fresh".into()), b"hello".to_vec()),
        ]
    );
}
#[test]
fn stop_during_instance_confirmation_sends_nothing() {
    use crate::scripted::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    let server = Scripted::start();
    server.on(
        "/",
        vec![Answer::Slow {
            after: Duration::from_millis(400),
            answer: Box::new(root(INSTANCE)),
        }],
    );
    server.on(
        "/items/a",
        vec![
            json(200, r#"{"ok":true}"#),
            certified(refusal(404, "item_not_found")),
        ],
    );
    let (_dir, core) = deleting(&server, &["a"]);
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let call = scope.spawn(|| core.drain_until(&stop));
        server.wait_for("/", 1, Duration::from_secs(5));
        assert!(server.seen("/items/a").is_empty());
        stop.store(true, Ordering::Relaxed);
        let result = call.join().unwrap();
        assert!(
            server.seen("/items/a").is_empty(),
            "sent after stop: {:?}; result: {result:?}",
            server.seen("/items/a")
        );
        assert_eq!(result.unwrap_err(), CoreError::Canceled);
    });
}

#[test]
fn stopped_drain_does_not_wait_for_another_drain() {
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;
    let core = Core::open_in_memory(None).unwrap();
    let held = core.one_drain();
    let stop = AtomicBool::new(true);
    let (sent, received) = std::sync::mpsc::channel();
    let immediate = std::thread::scope(|scope| {
        scope.spawn(|| sent.send(core.drain_until(&stop)).unwrap());
        let immediate = received.recv_timeout(Duration::from_millis(250));
        drop(held);
        immediate
    });
    assert!(
        immediate.is_ok(),
        "already-stopped call waited for other drain: {immediate:?}"
    );
    assert_eq!(immediate.unwrap().unwrap_err(), CoreError::Canceled);
}

#[test]
fn a_later_pass_adds_what_it_sent_and_leaves_what_it_left() {
    let mut first = report(3, 1);
    first.unclaimed_sources = vec!["a".into()];
    first.retry_after_seconds = Some(5);
    let mut later = report(2, 0);
    later.unclaimed_sources = vec!["a".into(), "b".into()];
    later.unavailable = Some("the server did not answer".into());
    later.undelivered = 4;
    first.absorb(later);
    assert_eq!(first.answered, 5);
    assert_eq!(first.held, 0, "what waits is what the later pass left");
    assert_eq!(first.undelivered, 4);
    assert_eq!(
        first.unavailable.as_deref(),
        Some("the server did not answer")
    );
    assert_eq!(first.unclaimed_sources, ["a", "b"]);
    assert_eq!(first.retry_after_seconds, Some(5));
}
