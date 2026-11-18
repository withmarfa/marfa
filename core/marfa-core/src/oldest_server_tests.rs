//! What a device does with the release a server's root names.

use marfa_rules::release::OLDEST_SERVER;

use crate::contract::CONTRACT_VERSION;
use crate::scripted::{self, Answer, INSTANCE, Scripted};
use crate::stop_tests::{copy, holding_a_catalog, note};
use crate::model::{BlockedReason, Verdict};
use crate::{CoreError, SliceTier, store};

fn root_running(version: &str) -> Answer {
    scripted::json(
        200,
        &format!(
            r#"{{"name":"marfa","version":{version},"instance_id":"{INSTANCE}","contract":{CONTRACT_VERSION},"features":[]}}"#
        ),
    )
}

fn root_of(release: &str) -> Answer {
    root_running(&format!("\"{release}\""))
}

fn too_old(served: &str) -> CoreError {
    CoreError::ServerTooOld {
        served: served.into(),
        oldest: OLDEST_SERVER.into(),
    }
}

/// What a copy holds that a refusal must leave as it was.
fn held(core: &crate::Core) -> (Option<String>, Vec<crate::QueuedWrite>) {
    let cursor = store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR).unwrap();
    (cursor, core.queue().unwrap())
}

type Door = (&'static str, fn(&crate::Core) -> Result<(), CoreError>);

fn doors() -> [Door; 3] {
    [
        ("a hydration", |core| {
            core.hydrate(&["core.note".into()], SliceTier::Library)
                .map(drop)
        }),
        ("a catch-up", |core| core.catch_up().map(drop)),
        ("a drain", |core| core.drain().map(drop)),
    ]
}

fn queued_copy(server: &Scripted) -> std::sync::Arc<crate::Core> {
    let core = copy(server);
    holding_a_catalog(&core);
    core.create_item(&note(None)).unwrap();
    core
}

#[test]
fn a_release_older_than_the_oldest_is_refused_at_the_root_with_nothing_else_sent() {
    for (door, call) in doors() {
        for served in ["0.0.74", "0.0.70", "0.0.9"] {
            let server = Scripted::start();
            let core = queued_copy(&server);
            server.on("/", vec![root_of(served)]);
            let before = held(&core);
            assert_eq!(call(&core).unwrap_err(), too_old(served), "{door}");
            assert_eq!(server.paths(), ["/"], "{door} against {served}");
            assert_eq!(held(&core), before, "{door} against {served}");
        }
    }
}

#[test]
fn the_error_names_both_releases_in_plain_words() {
    let message = too_old("0.0.74").to_string();
    assert!(message.contains("0.0.74"), "{message}");
    assert!(message.contains(OLDEST_SERVER), "{message}");
    assert_eq!(too_old("0.0.74").code(), "server_too_old");
}

#[test]
fn the_oldest_release_and_a_newer_one_are_let_through_to_the_rest_of_the_call() {
    for (door, call) in doors() {
        for served in [OLDEST_SERVER, "0.0.200", "0.1.0", "1.0.0"] {
            let server = Scripted::start();
            let core = queued_copy(&server);
            server.on("/", vec![root_of(served)]);
            let outcome = call(&core);
            assert!(
                !matches!(outcome, Err(CoreError::ServerTooOld { .. })),
                "{door} against {served}: {outcome:?}"
            );
            assert!(server.paths().len() > 1, "{door} against {served}");
        }
    }
}

#[test]
fn a_release_that_cannot_be_judged_is_let_through() {
    let unjudged = [
        r#""dev""#,
        r#""0.0.0""#,
        r#""banana""#,
        r#""0.0""#,
        r#""0.0.74.1""#,
        r#""v0.0.74""#,
        r#""""#,
        "74",
        "null",
    ];
    for (door, call) in doors() {
        for version in unjudged {
            let server = Scripted::start();
            let core = queued_copy(&server);
            server.on("/", vec![root_running(version)]);
            let outcome = call(&core);
            assert!(
                !matches!(outcome, Err(CoreError::ServerTooOld { .. })),
                "{door} against {version}: {outcome:?}"
            );
            assert!(server.paths().len() > 1, "{door} against {version}");
        }
    }
}

#[test]
fn a_root_naming_no_release_is_let_through() {
    let server = Scripted::start();
    let core = queued_copy(&server);
    server.on(
        "/",
        vec![scripted::json(
            200,
            &format!(
                r#"{{"name":"marfa","instance_id":"{INSTANCE}","contract":{CONTRACT_VERSION},"features":[]}}"#
            ),
        )],
    );
    assert!(!matches!(
        core.catch_up(),
        Err(CoreError::ServerTooOld { .. })
    ));
    assert!(server.paths().len() > 1);
}

#[test]
fn a_drain_refused_for_the_release_leaves_a_blocked_write_with_its_verdict() {
    let server = Scripted::start();
    let core = queued_copy(&server);
    store::block_unanswered(&core.conn().unwrap(), BlockedReason::CredentialRefused).unwrap();
    let before = held(&core);
    let blocked = &before.1[0];
    assert_eq!(blocked.verdict, Some(Verdict::Blocked), "the witness is blocked");
    assert!(blocked.answered_at.is_some(), "the witness has an answer time");
    server.on("/", vec![root_of("0.0.77")]);
    assert_eq!(core.drain().unwrap_err(), too_old("0.0.77"));
    assert_eq!(server.paths(), ["/"]);
    assert_eq!(held(&core), before);
}
