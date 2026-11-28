//! A catch-up whose events committed answers success when the fill of the
//! tables it holds fails because the server is out of reach, and names the
//! failure in `tables` (`device/table-fill-failed-after-events`). Any other
//! failure of the fill is the catch-up's.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::scripted::{self, Then};
use crate::table_fill_waits_tests::{LEDGER, ROWS, STEPS, copy, cursor, events, state, until};
use crate::{CoreError, fault};

fn owe_steps(core: &crate::Core) {
    crate::tables::choose(&mut core.conn().unwrap(), LEDGER, STEPS).unwrap();
    assert_eq!(state(core, STEPS).as_deref(), Some("owed"));
}

#[test]
fn a_catch_up_whose_fill_fails_after_its_events_reports_success_and_the_failure() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);
    let _failing = fault::fail_on_this_thread("table-fill-read");

    let report = copy
        .core
        .catch_up()
        .expect("the catch-up took its events and failed only the fill");

    assert_eq!((report.applied, report.cursor.as_str()), (1, "11"));
    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
    assert_eq!(report.tables.whole, 0);
    assert_eq!((report.tables.failed, report.tables.unfilled), (1, 1));
    let failure = report.tables.failure.expect("the failure is named");
    assert!(failure.contains(STEPS), "{failure}");
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("owed"));
}

#[test]
fn a_table_the_fill_left_owed_is_filled_by_the_next_catch_up() {
    let copy = copy();
    copy.server.on(
        "/events",
        vec![
            events("11", &[("e1", "11")], Then::End),
            events("11", &[], Then::End),
        ],
    );
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);
    {
        let _failing = fault::fail_on_this_thread("table-fill-read");
        assert!(copy.core.catch_up().unwrap().tables.failure.is_some());
    }
    let report = copy.core.catch_up().unwrap();
    assert_eq!(report.tables.failure, None);
    assert_eq!((report.tables.whole, report.tables.unfilled), (1, 0));
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("whole"));
}

#[test]
fn a_catch_up_whose_fill_succeeds_reports_no_failure() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let report = copy.core.catch_up().unwrap();

    assert_eq!((report.applied, report.cursor.as_str()), (1, "11"));
    assert_eq!(report.tables.failure, None);
    assert_eq!((report.tables.whole, report.tables.failed), (1, 0));
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("whole"));
}

#[test]
fn a_server_answer_that_names_no_contract_fails_the_fill_not_the_catch_up() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.server
        .on(ROWS, vec![scripted::unnamed(502, "bad_gateway")]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let report = copy.core.catch_up().expect("the events committed");

    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
    assert!(report.tables.failure.is_some(), "{:?}", report.tables);
    assert_eq!(report.tables.whole, 0);
}

#[test]
fn a_failure_before_the_events_commit_stays_an_error() {
    let copy = copy();
    copy.server
        .on("/events", vec![scripted::unnamed(502, "bad_gateway")]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let error = copy
        .core
        .catch_up()
        .expect_err("the events were never taken");

    assert!(error.is_environmental(), "{error:?}");
    assert!(!matches!(error, CoreError::Canceled));
    assert_eq!(cursor(&copy.core).as_deref(), Some("10"));
}

const TABLES: &str = "/items/n1/tables";

#[test]
fn a_server_out_of_reach_on_the_tables_summary_fails_the_fill_not_the_catch_up() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.server
        .on(TABLES, vec![scripted::unnamed(503, "unavailable")]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let report = copy.core.catch_up().expect("the events committed");

    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
    assert_eq!((report.tables.failed, report.tables.unfilled), (1, 1));
    assert!(report.tables.failure.is_some(), "{:?}", report.tables);
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("owed"));
}

#[test]
fn a_refused_credential_on_the_fill_is_the_catch_ups_error() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.server
        .on(TABLES, vec![scripted::refusal(401, "unauthorized")]);
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let error = copy
        .core
        .catch_up()
        .expect_err("a refused credential is not the server being out of reach");

    match error {
        CoreError::CopyExpired { reason, .. } => assert_eq!(reason, "credential_ended"),
        other => panic!("the refusal was contained or misnamed: {other:?}"),
    }
}

#[test]
fn a_copy_expired_on_the_fill_is_the_catch_ups_error() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.server.on(
        TABLES,
        vec![scripted::refusal(409, crate::http::INSTANCE_CHANGED)],
    );
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let error = copy
        .core
        .catch_up()
        .expect_err("the server is not this copy's");

    match error {
        CoreError::CopyExpired { reason, .. } => {
            assert_eq!(reason, crate::http::INSTANCE_CHANGED);
        }
        other => panic!("not expired: {other:?}"),
    }
}

#[test]
fn a_stop_raised_during_the_fill_after_the_events_commit_ends_the_catch_up_as_canceled() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    let ready = Arc::new(AtomicBool::new(false));
    copy.server.on(
        TABLES,
        vec![until(&ready, scripted::refusal(503, "unavailable"))],
    );
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);
    let stop = Arc::new(AtomicBool::new(false));
    let call = {
        let (core, stop) = (Arc::clone(&copy.core), Arc::clone(&stop));
        std::thread::spawn(move || core.catch_up_until(&stop))
    };

    copy.server.wait_for(TABLES, 1, Duration::from_secs(10));
    stop.store(true, Ordering::SeqCst);
    ready.store(true, Ordering::SeqCst);
    let ended = call.join().expect("the catch-up thread panicked");

    let failed = ended.expect_err("a stop is never a success");
    assert!(matches!(failed.error, CoreError::Canceled), "{failed:?}");
    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
}

#[test]
fn a_redirect_on_the_fill_is_the_catch_ups_error_with_its_events_kept() {
    let copy = copy();
    copy.server
        .on("/events", vec![events("11", &[("e1", "11")], Then::End)]);
    copy.server.on(
        TABLES,
        vec![scripted::Answer::Json {
            status: 302,
            body: "{}".into(),
            headers: vec![("Location".into(), "http://127.0.0.1:9".into())],
        }],
    );
    copy.go.store(true, Ordering::SeqCst);
    owe_steps(&copy.core);

    let error = copy
        .core
        .catch_up()
        .expect_err("a redirect is not the server being out of reach");

    assert!(matches!(error, CoreError::Redirected { .. }), "{error:?}");
    assert_eq!(cursor(&copy.core).as_deref(), Some("11"));
    assert_eq!(state(&copy.core, STEPS).as_deref(), Some("owed"));
}
