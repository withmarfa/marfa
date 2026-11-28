//! A catch-up whose events committed answers success when the fill of the
//! tables it holds fails, and names the failure in `tables`
//! (`device/table-fill-failed-after-events`).

use std::sync::atomic::Ordering;

use crate::scripted::{self, Then};
use crate::table_fill_waits_tests::{LEDGER, ROWS, STEPS, copy, cursor, events, state};
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
