use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::body::resolve::{Resolved, Resolver};
use crate::body::rule::Placements;
use crate::scripted::{self, Scripted};
use crate::stop_tests::copy_in_keyed;
use crate::tables::RowsAsked;
use crate::{Core, CoreError, Handle, Server, store};

const OTHER: &str = "00000000-0000-7000-8000-000000000001";
const ITEM: &str = "01a1011a-4902-76cf-a4a9-88e99c038c8d";
const MOVED_FROM: &str = "http://127.0.0.1:8";

fn writer_and_reader(server: &Scripted) -> (tempfile::TempDir, Arc<Core>, Core) {
    let dir = tempfile::tempdir().unwrap();
    let writer = copy_in_keyed(server, dir.path(), "k");
    let reader = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    (dir, writer, reader)
}

fn store_bytes(dir: &tempfile::TempDir) -> Vec<Vec<u8>> {
    ["core.sqlite", "core.sqlite-wal"]
        .iter()
        .map(|name| std::fs::read(dir.path().join(name)).unwrap_or_default())
        .collect()
}

fn expired(core: &Core) -> bool {
    crate::reach::expired(&core.conn().unwrap()).unwrap()
}

fn answers(server: &Scripted) {
    let base = format!("/items/{ITEM}/tables/lines");
    server.on(
        &format!("{base}/rows"),
        vec![scripted::json(200, r#"{"data":[],"next_cursor":null}"#)],
    );
    server.on(
        &format!("{base}/rows/r1"),
        vec![scripted::json(200, r#"{"id":"r1"}"#)],
    );
    server.on(
        &format!("{base}/totals"),
        vec![scripted::json(200, r#"{"row_count":0,"totals":{}}"#)],
    );
    server.on(
        &format!("/items/{ITEM}"),
        vec![scripted::refusal(404, "not_found")],
    );
}

fn requests(server: &Scripted) -> usize {
    ["/rows", "/rows/r1", "/totals"]
        .iter()
        .map(|end| {
            server
                .seen(&format!("/items/{ITEM}/tables/lines{end}"))
                .len()
        })
        .sum::<usize>()
        + server.seen(&format!("/items/{ITEM}")).len()
}

fn read_a_table(core: &Core, door: usize) -> crate::Result<()> {
    match door {
        0 => core
            .table_rows(ITEM, "lines", &RowsAsked::default())
            .map(|_| ()),
        1 => core.table_row(ITEM, "lines", "r1").map(|_| ()),
        2 => core.table_totals(ITEM, "lines", None).map(|_| ()),
        _ => {
            let catalog = crate::catalog::load(&core.conn().unwrap()).unwrap();
            let mut resolver = Resolver::new(core, &catalog, &Placements, &crate::NEVER_STOPPED);
            resolver.resolve(ITEM).map(|resolved| {
                assert!(matches!(resolved, Resolved::Unmatched), "{resolved:?}");
            })
        }
    }
}

const DOORS: [&str; 4] = ["rows", "one row", "totals", "a link by id"];

#[test]
fn a_table_read_or_link_lookup_sends_no_item_id_to_another_instance_and_expires_the_copy() {
    for (door, name) in DOORS.iter().enumerate() {
        let server = Scripted::start();
        answers(&server);
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");

        read_a_table(&core, door).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(requests(&server), 1, "{name}");
        assert!(!expired(&core), "{name}");

        server.on("/", vec![scripted::root(OTHER)]);
        let refusal = read_a_table(&core, door).unwrap_err();
        assert_eq!(refusal.code(), "copy_expired", "{name}: {refusal:?}");
        assert_eq!(
            requests(&server),
            1,
            "{name}: an item id reached another instance"
        );
        assert!(expired(&core), "{name}: the copy was left unexpired");
    }
}

#[test]
fn a_reading_handle_reads_a_table_or_link_for_its_instance_and_refuses_another_writing_nothing() {
    for (door, name) in DOORS.iter().enumerate() {
        let server = Scripted::start();
        answers(&server);
        let (dir, writer, reader) = writer_and_reader(&server);
        let before = store_bytes(&dir);

        read_a_table(&reader, door).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(requests(&server), 1, "{name}");
        assert!(store_bytes(&dir) == before, "{name}: the store changed");

        server.on("/", vec![scripted::root(OTHER)]);
        let refusal = read_a_table(&reader, door).unwrap_err();
        assert_eq!(refusal.code(), "copy_expired", "{name}: {refusal:?}");
        assert_eq!(requests(&server), 1, "{name}");
        assert!(!expired(&writer), "{name}: the reader expired the copy");
        assert!(store_bytes(&dir) == before, "{name}: the store changed");

        assert_eq!(
            read_a_table(&writer, door).unwrap_err().code(),
            "copy_expired",
            "{name}"
        );
        assert!(expired(&writer), "{name}");
    }
}

const OTHER_ITEM: &str = "01a1011a-4902-76cf-a4a9-88e99c038c8e";

fn with_resolver<T>(core: &Core, stop: &AtomicBool, ask: impl FnOnce(&mut Resolver<'_>) -> T) -> T {
    let catalog = crate::catalog::load(&core.conn().unwrap()).unwrap();
    let mut resolver = Resolver::new(core, &catalog, &Placements, stop);
    ask(&mut resolver)
}

#[test]
fn a_link_lookup_confirms_the_instance_before_each_id_it_asks() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    server.on(
        &format!("/items/{OTHER_ITEM}"),
        vec![scripted::refusal(404, "x")],
    );
    with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        assert!(matches!(
            resolver.resolve(ITEM).unwrap(),
            Resolved::Unmatched
        ));
        assert_eq!(server.seen("/").len(), 1);
        assert!(matches!(
            resolver.resolve(OTHER_ITEM).unwrap(),
            Resolved::Unmatched
        ));
        assert_eq!(server.seen("/").len(), 2);
    });
}

#[test]
fn an_instance_replaced_between_two_link_lookups_is_sent_no_second_id() {
    let server = Scripted::start();
    answers(&server);
    server.on(
        "/",
        vec![scripted::root(scripted::INSTANCE), scripted::root(OTHER)],
    );
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    server.on(
        &format!("/items/{OTHER_ITEM}"),
        vec![scripted::refusal(404, "x")],
    );
    with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        assert!(matches!(
            resolver.resolve(ITEM).unwrap(),
            Resolved::Unmatched
        ));
        let refusal = resolver.resolve(OTHER_ITEM).unwrap_err();
        assert_eq!(refusal.code(), "copy_expired", "{refusal:?}");
    });
    assert_eq!(server.seen(&format!("/items/{ITEM}")).len(), 1);
    assert!(
        server.seen(&format!("/items/{OTHER_ITEM}")).is_empty(),
        "an id reached the instance that replaced the one asked first"
    );
    assert!(expired(&core));
}

fn renewed_once(server: &Scripted, path: &str, then: scripted::Answer) {
    server.on(path, vec![scripted::refusal(401, "unauthorized"), then]);
}

fn renew(core: &Core) {
    core.renew_credential_with(Box::new(|_| Ok("fresh".into())));
}

#[test]
fn a_table_or_link_read_retried_after_a_renewal_confirms_the_instance_again() {
    for (door, name) in DOORS.iter().enumerate() {
        let path = match door {
            0 => format!("/items/{ITEM}/tables/lines/rows"),
            1 => format!("/items/{ITEM}/tables/lines/rows/r1"),
            2 => format!("/items/{ITEM}/tables/lines/totals"),
            _ => format!("/items/{ITEM}"),
        };
        let answer = match door {
            0 => scripted::json(200, r#"{"data":[],"next_cursor":null}"#),
            1 => scripted::json(200, r#"{"id":"r1"}"#),
            2 => scripted::json(200, r#"{"row_count":0,"totals":{}}"#),
            _ => scripted::refusal(404, "not_found"),
        };

        let server = Scripted::start();
        answers(&server);
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        renew(&core);
        renewed_once(&server, &path, answer.clone());
        read_a_table(&core, door).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(
            server.seen(&path).len(),
            2,
            "{name}: the witness did not retry"
        );
        assert_eq!(
            server.seen("/").len(),
            2,
            "{name}: the retry was not confirmed"
        );

        let server = Scripted::start();
        answers(&server);
        server.on(
            "/",
            vec![scripted::root(scripted::INSTANCE), scripted::root(OTHER)],
        );
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        renew(&core);
        renewed_once(&server, &path, answer);
        let refusal = read_a_table(&core, door).unwrap_err();
        assert_eq!(refusal.code(), "copy_expired", "{name}: {refusal:?}");
        assert_eq!(
            server.seen(&path).len(),
            1,
            "{name}: the retry reached the instance that replaced the first"
        );
        assert!(expired(&core), "{name}");
    }
}

#[test]
fn a_stopped_link_lookup_ends_canceled_and_sends_nothing() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");

    with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        resolver.resolve(ITEM).unwrap();
    });
    let (roots, items) = (
        server.seen("/").len(),
        server.seen(&format!("/items/{ITEM}")).len(),
    );
    assert_eq!((roots, items), (1, 1), "the witness sent nothing");

    let stopped = AtomicBool::new(true);
    let error = with_resolver(&core, &stopped, |resolver| {
        resolver.resolve(OTHER_ITEM).unwrap_err()
    });
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    assert_eq!(server.seen("/").len(), roots);
    assert!(server.seen(&format!("/items/{OTHER_ITEM}")).is_empty());
}

fn with_waiting_link(core: &Core) {
    core.create_item(&crate::model::Draft {
        r#type: "core.note".into(),
        properties: serde_json::json!({ "title": "Host", "body": format!("[[{ITEM}]]") })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    })
    .unwrap();
}

#[test]
fn settling_bodies_ends_canceled_when_stopped_and_sends_nothing() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    with_waiting_link(&core);

    let stopped = AtomicBool::new(true);
    let error = core.settle_bodies(&stopped).unwrap_err();
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    assert!(server.seen("/").is_empty());
    assert!(server.seen(&format!("/items/{ITEM}")).is_empty());

    core.settle_bodies(&crate::NEVER_STOPPED).unwrap();
    assert_eq!(
        server.seen(&format!("/items/{ITEM}")).len(),
        1,
        "the witness asked nothing"
    );
}

fn settled_while_the_root_is_read(
    server: &Scripted,
    core: &Core,
    meanwhile: impl FnOnce(&Core),
) -> CoreError {
    with_waiting_link(core);
    server.on(
        "/",
        vec![scripted::Answer::Slow {
            after: std::time::Duration::from_millis(300),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    std::thread::scope(|scope| {
        let settling = scope.spawn(|| core.settle_bodies(&crate::NEVER_STOPPED));
        server.wait_for("/", 1, std::time::Duration::from_secs(2));
        meanwhile(core);
        settling.join().unwrap().unwrap_err()
    })
}

#[test]
fn settling_bodies_reports_a_copy_another_operation_expired_while_the_root_was_read() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let error = settled_while_the_root_is_read(&server, &core, |core| {
        crate::reach::expire(&core.conn().unwrap()).unwrap();
    });
    assert_eq!(error.code(), "copy_expired", "{error:?}");
    assert!(expired(&core));
}

#[test]
fn settling_bodies_keeps_stream_incomplete_for_a_copy_that_is_not_expired() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let error = settled_while_the_root_is_read(&server, &core, |core| {
        crate::reach::advance_generation(&core.conn().unwrap()).unwrap();
    });
    assert_eq!(error.code(), "stream_incomplete", "{error:?}");
    assert!(!expired(&core));
}

const SLOW: std::time::Duration = std::time::Duration::from_millis(400);

fn slowly(answers: Vec<scripted::Answer>) -> Vec<scripted::Answer> {
    answers
        .into_iter()
        .map(|answer| scripted::Answer::Slow {
            after: SLOW,
            answer: Box::new(answer),
        })
        .collect()
}

fn renewals_counted(core: &Core) -> Arc<std::sync::atomic::AtomicUsize> {
    let renewals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&renewals);
    core.renew_credential_with(Box::new(move |_| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok("fresh".into())
    }));
    renewals
}

fn name_states(core: &Core) -> Vec<String> {
    core.conn()
        .unwrap()
        .prepare("SELECT state FROM body_names")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn settled_through_a_slow_read(
    first: scripted::Answer,
    then: Option<scripted::Answer>,
    stopping: bool,
) -> (Result<(), CoreError>, usize, Vec<String>, bool) {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let renewals = renewals_counted(&core);
    let path = format!("/items/{ITEM}");
    server.on(
        &path,
        slowly([Some(first), then].into_iter().flatten().collect()),
    );
    with_waiting_link(&core);
    let stop = AtomicBool::new(false);
    let settled = std::thread::scope(|scope| {
        let settling = scope.spawn(|| core.settle_bodies(&stop));
        if stopping {
            server.wait_for(&path, 1, std::time::Duration::from_secs(2));
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        settling.join().unwrap()
    });
    (
        settled,
        renewals.load(std::sync::atomic::Ordering::SeqCst),
        name_states(&core),
        crate::body::rule::waiting(&core.conn().unwrap()).unwrap(),
    )
}

#[test]
fn a_stop_during_a_link_read_ends_canceled_renewing_nothing_and_recording_nothing() {
    let renewed = || scripted::refusal(401, "unauthorized");
    let absent = || scripted::refusal(404, "not_found");

    let (settled, renewals, states, _) =
        settled_through_a_slow_read(renewed(), Some(absent()), false);
    settled.unwrap();
    assert_eq!(renewals, 1, "the witness did not renew");
    assert!(states.iter().any(|state| state == "missing"), "{states:?}");

    let (settled, renewals, states, owed) =
        settled_through_a_slow_read(renewed(), Some(absent()), true);
    assert!(matches!(settled, Err(CoreError::Canceled)), "{settled:?}");
    assert_eq!(renewals, 0, "a stopped lookup renewed the credential");
    assert!(states.iter().all(|state| state != "missing"), "{states:?}");
    assert!(owed, "the stop lost the recheck");

    let (settled, renewals, states, owed) = settled_through_a_slow_read(absent(), None, true);
    assert!(matches!(settled, Err(CoreError::Canceled)), "{settled:?}");
    assert_eq!(renewals, 0);
    assert!(
        states.iter().all(|state| state != "missing"),
        "a late answer was recorded: {states:?}"
    );
    assert!(owed, "the stop lost the recheck");
}

#[test]
fn a_core_dropped_after_a_stopped_link_lookup_leaves_the_copy_to_open_as_the_writer() {
    let server = Scripted::start();
    answers(&server);
    let path = format!("/items/{ITEM}");
    server.on(&path, slowly(vec![scripted::refusal(404, "not_found")]));
    let (dir, writer, reader) = moved(&server, scripted::INSTANCE);
    drop(reader);
    let stop = AtomicBool::new(false);
    let error = std::thread::scope(|scope| {
        let looking =
            scope.spawn(|| with_resolver(&writer, &stop, |resolver| resolver.resolve(ITEM)));
        server.wait_for(&path, 1, std::time::Duration::from_secs(2));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        looking.join().unwrap().unwrap_err()
    });
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    drop(writer);
    let reopened = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    assert_eq!(reopened.handle(), Handle::Writer);
}

#[test]
fn a_root_refused_as_not_found_at_a_moved_origin_leaves_the_lookup_unanswered() {
    let server = Scripted::start();
    answers(&server);
    let (_dir, writer, reader) = moved(&server, scripted::INSTANCE);
    server.on("/", vec![scripted::refusal(404, "not_found")]);
    for core in [&*writer, &reader] {
        let resolved = with_resolver(core, &crate::NEVER_STOPPED, |resolver| {
            resolver.resolve(ITEM)
        });
        assert!(
            !matches!(resolved, Ok(Resolved::Unmatched)),
            "the failed identity read concluded the item is missing: {resolved:?}"
        );
    }
    assert!(
        server.seen(&format!("/items/{ITEM}")).is_empty(),
        "an id was sent before the instance was known"
    );
}

#[test]
fn a_root_refused_as_not_found_keeps_the_details_the_server_sent() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    server.on(
        "/",
        vec![scripted::json(
            404,
            r#"{"error":{"code":"not_found","message":"no route","details":{"route":"/"}}}"#,
        )],
    );
    let error = core.http().unwrap().instance_id().unwrap_err();
    assert!(
        matches!(&error, CoreError::Server { status: 404, .. }),
        "{error:?}"
    );
    let answer = error.answer().unwrap();
    assert_eq!(answer.status, 404);
    assert_eq!(answer.code.as_deref(), Some("not_found"));
    assert_eq!(answer.details, Some(serde_json::json!({ "route": "/" })));
}

#[test]
fn a_failed_identity_check_leaves_a_link_lookup_unanswered() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    server.on("/", vec![scripted::refusal(404, "not_found")]);
    with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        let resolved = resolver.resolve(ITEM);
        assert!(
            !matches!(resolved, Ok(Resolved::Unmatched)),
            "the failed check concluded the item is missing: {resolved:?}"
        );
    });
    with_waiting_link(&core);
    core.settle_bodies(&crate::NEVER_STOPPED).unwrap();
    let states: Vec<String> = core
        .conn()
        .unwrap()
        .prepare("SELECT state FROM body_names")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        !states.is_empty() && states.iter().all(|state| state != "missing"),
        "{states:?}"
    );
    assert!(server.seen(&format!("/items/{ITEM}")).is_empty());
}

#[test]
fn a_stop_during_the_root_read_keeps_a_link_recheck_owed() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    with_waiting_link(&core);
    core.settle_bodies(&crate::NEVER_STOPPED).unwrap();
    {
        let conn = core.conn().unwrap();
        let missing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM body_names WHERE state = 'missing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(missing, 1, "the witness has no answered name");
        conn.execute("UPDATE body_names SET held = 1", []).unwrap();
        crate::body::rule::rows_changed(&conn).unwrap();
        assert!(crate::body::rule::waiting(&conn).unwrap());
    }
    server.on(
        "/",
        vec![scripted::Answer::Slow {
            after: std::time::Duration::from_millis(600),
            answer: Box::new(scripted::root(scripted::INSTANCE)),
        }],
    );
    let seen = server.seen("/").len();
    let stop = AtomicBool::new(false);
    let error = std::thread::scope(|scope| {
        let settling = scope.spawn(|| core.settle_bodies(&stop));
        server.wait_for("/", seen + 1, std::time::Duration::from_secs(2));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        settling.join().unwrap().unwrap_err()
    });
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    assert!(
        crate::body::rule::waiting(&core.conn().unwrap()).unwrap(),
        "the stop lost the recheck"
    );
}

#[test]
fn a_reading_handle_that_is_renewed_writes_nothing_and_keeps_working() {
    let server = Scripted::start();
    answers(&server);
    let (dir, writer, reader) = writer_and_reader(&server);
    let sent_as = |core: &Core| {
        store::meta_get(&core.conn().unwrap(), "upload_sent_as/queued")
            .unwrap()
            .unwrap()
    };
    let first = store::credential_digest("Bearer k");
    let fresh = store::credential_digest("Bearer fresh");
    store::meta_set(&writer.conn().unwrap(), "upload_sent_as/queued", &first).unwrap();
    let before = store_bytes(&dir);
    let renewed = || {
        server.on(
            "/types",
            vec![
                scripted::refusal(401, "unauthorized"),
                scripted::certified(scripted::types(&[("core.note", None)])),
            ],
        );
    };

    renewed();
    reader.renew_credential_with(Box::new(|_| Ok("fresh".into())));
    reader.http().unwrap().types().unwrap();
    assert_eq!(
        server
            .seen("/types")
            .last()
            .and_then(|seen| seen.authorization.clone())
            .as_deref(),
        Some("Bearer fresh"),
        "the renewed call did not keep working"
    );
    assert_eq!(reader.http().unwrap().authorization(), "Bearer fresh");
    assert!(store_bytes(&dir) == before, "the reading handle wrote");
    assert_eq!(sent_as(&writer), first);

    renewed();
    writer.renew_credential_with(Box::new(|current| match current {
        "k" => Ok("fresh".into()),
        "fresh" => Ok("fresher".into()),
        other => panic!("unexpected credential: {other}"),
    }));
    writer.http().unwrap().types().unwrap();
    assert_eq!(sent_as(&writer), fresh);
    renewed();
    writer.http().unwrap().types().unwrap();
    assert_eq!(writer.http().unwrap().authorization(), "Bearer fresher");
    assert_eq!(sent_as(&writer), store::credential_digest("Bearer fresher"));
}

fn moved(server: &Scripted, instance: &str) -> (tempfile::TempDir, Arc<Core>, Core) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = Core::open(&path, None).unwrap();
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SERVER_ORIGIN, MOVED_FROM).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, instance).unwrap();
    }
    drop(core);
    let open = || {
        Core::open(
            &path,
            Some(Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap()
    };
    let writer = Arc::new(open());
    assert_eq!(writer.handle(), Handle::Writer);
    let reader = open();
    assert_eq!(reader.handle(), Handle::Reader);
    (dir, writer, reader)
}

fn origin(core: &Core) -> String {
    store::meta_get(&core.conn().unwrap(), store::META_SERVER_ORIGIN)
        .unwrap()
        .unwrap()
}

#[test]
fn a_reading_handle_at_a_moved_origin_sends_for_the_copys_instance_and_leaves_the_move_to_the_writer()
 {
    let server = Scripted::start();
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    let (dir, writer, reader) = moved(&server, scripted::INSTANCE);
    let before = store_bytes(&dir);

    reader.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/types").len(), 1);
    assert_eq!(origin(&reader), MOVED_FROM);
    assert!(store_bytes(&dir) == before, "the reading handle wrote");
    let roots = server.seen("/").len();
    reader.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/").len(), roots);

    writer.http().unwrap().types().unwrap();
    assert_eq!(origin(&writer), server.url());
}

#[test]
fn a_reading_handle_at_a_moved_origin_refuses_another_instance_and_sends_nothing() {
    let server = Scripted::start();
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    server.on("/", vec![scripted::root(OTHER)]);
    let (dir, writer, reader) = moved(&server, scripted::INSTANCE);
    let before = store_bytes(&dir);

    let refusal = reader.http().unwrap().types().unwrap_err();
    assert!(
        matches!(refusal, CoreError::WrongServer { .. }),
        "{refusal:?}"
    );
    assert!(server.seen("/types").is_empty());
    assert!(store_bytes(&dir) == before);
    assert!(matches!(
        writer.http().unwrap().types(),
        Err(CoreError::WrongServer { .. })
    ));
    assert_eq!(origin(&writer), MOVED_FROM);
}

#[test]
fn a_reading_handle_at_a_moved_origin_refuses_a_copy_the_writer_has_since_built_again() {
    let server = Scripted::start();
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    let (_dir, writer, reader) = moved(&server, scripted::INSTANCE);
    store::meta_set(&writer.conn().unwrap(), store::META_INSTANCE_ID, OTHER).unwrap();

    let refusal = reader.http().unwrap().types().unwrap_err();
    assert!(
        matches!(refusal, CoreError::WrongServer { .. }),
        "{refusal:?}"
    );
    assert!(server.seen("/types").is_empty());
}

#[test]
fn a_reading_handle_and_the_writer_at_a_moved_origin_both_send_at_once() {
    let server = Scripted::start();
    server.on(
        "/types",
        vec![scripted::certified(scripted::types(&[("core.note", None)]))],
    );
    let (_dir, writer, reader) = moved(&server, scripted::INSTANCE);
    let reader = Arc::new(reader);
    let threads: Vec<_> = (0..8)
        .map(|at| {
            let (writer, reader) = (Arc::clone(&writer), Arc::clone(&reader));
            std::thread::spawn(move || {
                let core = if at % 2 == 0 { writer } else { reader };
                core.http().unwrap().types().map(|_| ())
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap().unwrap();
    }
    assert_eq!(server.seen("/types").len(), 8);
    assert_eq!(origin(&writer), server.url());
}

#[cfg(debug_assertions)]
fn until(what: &str, done: impl Fn() -> bool) {
    let by = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < by, "{what}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(debug_assertions)]
type Looked = crate::Result<Option<crate::wire::WireItemWithMetadata>>;

/// Two lookups of a link by id, each refused once with `401`, the first
/// renewal failing once `fail` says so. Answers how each lookup ended, how
/// many renewals started and how many item requests were sent, once both
/// requests have ended.
#[cfg(debug_assertions)]
fn lookups_behind_a_failing_renewal(
    stop: &AtomicBool,
    fail: impl Fn() -> bool + Send + Sync + 'static,
    before_failing: impl FnOnce(),
) -> ([Looked; 2], usize, usize) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    crate::fault::observe(true);
    let ended_before = crate::fault::reached("request-ended");
    let started = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&started);
    core.renew_credential_with(Box::new(move |_| {
        if counted.fetch_add(1, Ordering::SeqCst) == 0 {
            until("the first renewal was never let fail", &fail);
            return Err(CoreError::Network("the renewal failed".into()));
        }
        Ok("fresh".into())
    }));
    let paths = [format!("/items/{ITEM}"), format!("/items/{OTHER_ITEM}")];
    for path in &paths {
        renewed_once(&server, path, scripted::refusal(404, "not_found"));
    }
    let http = core.http().unwrap();
    let ended = std::thread::scope(|scope| {
        let lookups = [ITEM, OTHER_ITEM].map(|id| {
            scope.spawn(|| crate::catch_up::item_checked_unless_stopped(&core, http, stop, id))
        });
        for path in &paths {
            server.wait_for(path, 1, std::time::Duration::from_secs(5));
        }
        until("no renewal started", || started.load(Ordering::SeqCst) > 0);
        before_failing();
        lookups.map(|lookup| lookup.join().unwrap())
    });
    until("a lookup's request never ended", || {
        crate::fault::reached("request-ended") == ended_before + 2
    });
    let sent = paths.iter().map(|path| server.seen(path).len()).sum();
    (ended, started.load(Ordering::SeqCst), sent)
}

#[cfg(debug_assertions)]
#[test]
fn a_lookup_waiting_for_a_renewal_that_fails_starts_none_of_its_own_once_stopped() {
    let stop = AtomicBool::new(false);
    let (ended, started, _) = lookups_behind_a_failing_renewal(
        &stop,
        || crate::fault::reached("request-let-go") == 2,
        || stop.store(true, std::sync::atomic::Ordering::SeqCst),
    );
    assert!(
        ended
            .iter()
            .all(|ended| matches!(ended, Err(CoreError::Canceled))),
        "{ended:?}"
    );
    assert_eq!(started, 1, "a lookup renewed the credential after the stop");
}

#[cfg(debug_assertions)]
#[test]
fn a_lookup_stopped_before_its_caller_looks_again_starts_no_renewal_of_its_own() {
    for stopped in [true, false] {
        let stop = Arc::new(AtomicBool::new(false));
        let fail = Arc::new(AtomicBool::new(false));
        let failing = Arc::clone(&fail);
        // Fails at once after the stop, before the caller looks again.
        let (ended, started, sent) = lookups_behind_a_failing_renewal(
            &stop,
            move || failing.load(std::sync::atomic::Ordering::SeqCst),
            || {
                if stopped {
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                fail.store(true, std::sync::atomic::Ordering::SeqCst);
            },
        );
        if stopped {
            assert_eq!(started, 1, "a lookup renewed after the stop: {ended:?}");
            assert_eq!(sent, 2, "a lookup was sent again after the stop");
            assert!(
                ended.iter().all(|ended| ended.is_err()),
                "a stopped lookup was answered: {ended:?}"
            );
        } else {
            assert_eq!(started, 2, "the waiting lookup did not renew: {ended:?}");
            assert_eq!(sent, 3);
            assert!(
                ended.iter().any(|ended| matches!(ended, Ok(None))),
                "{ended:?}"
            );
        }
    }
}

#[test]
fn a_stop_raised_while_the_instance_check_reads_the_root_sends_no_item_request() {
    for retried in [false, true] {
        let server = Scripted::start();
        answers(&server);
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        renew(&core);
        let path = format!("/items/{ITEM}");
        if retried {
            renewed_once(&server, &path, scripted::refusal(404, "not_found"));
        }
        let roots = if retried { 2 } else { 1 };
        server.on("/", slowly(vec![scripted::root(scripted::INSTANCE); roots]));
        let stop = AtomicBool::new(false);
        let error = std::thread::scope(|scope| {
            let looking =
                scope.spawn(|| with_resolver(&core, &stop, |resolver| resolver.resolve(ITEM)));
            if retried {
                server.wait_for(&path, 1, std::time::Duration::from_secs(2));
            }
            server.wait_for("/", roots, std::time::Duration::from_secs(2));
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
            let raised = std::time::Instant::now();
            let ended = looking.join().unwrap().unwrap_err();
            assert!(raised.elapsed() < SLOW, "{retried}: waited on the root");
            std::thread::sleep(SLOW + std::time::Duration::from_millis(200));
            ended
        });
        assert!(matches!(error, CoreError::Canceled), "{retried}: {error:?}");
        assert_eq!(
            server.seen(&path).len(),
            usize::from(retried),
            "{retried}: an item request was sent after the stop"
        );
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_lookup_stopped_while_the_root_is_read_sends_no_item_request_however_soon_the_root_answers() {
    for stopped in [true, false] {
        let server = Scripted::start();
        answers(&server);
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        crate::fault::observe(true);
        let ended_before = crate::fault::reached("request-ended");
        let ready = Arc::new(AtomicBool::new(false));
        let roots = server.seen("/").len();
        server.on(
            "/",
            vec![scripted::Answer::WaitFor {
                ready: Arc::clone(&ready),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            }],
        );
        let path = format!("/items/{ITEM}");
        let stop = AtomicBool::new(false);
        let http = core.http().unwrap();
        let ended = std::thread::scope(|scope| {
            let looking = scope
                .spawn(|| crate::catch_up::item_checked_unless_stopped(&core, http, &stop, ITEM));
            server.wait_for("/", roots + 1, std::time::Duration::from_secs(5));
            // Answers at once after the stop, before the caller looks again.
            if stopped {
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            ready.store(true, std::sync::atomic::Ordering::SeqCst);
            looking.join().unwrap()
        });
        until("the lookup's request never ended", || {
            crate::fault::reached("request-ended") == ended_before + 1
        });
        if stopped {
            assert!(matches!(ended, Err(CoreError::Canceled)), "{ended:?}");
            assert!(
                server.seen(&path).is_empty(),
                "an item request was sent after the stop"
            );
        } else {
            assert!(matches!(ended, Ok(None)), "{ended:?}");
            assert_eq!(server.seen(&path).len(), 1);
        }
    }
}

/// A follow of a copy whose stream open waits on `held`, answered `first`
/// once released, which is just after the stop where `stopped`, and `then`
/// after. Answers the
/// paths the open then sent and how many renewals started, once the open's
/// request has ended, or, where nothing stops it, once the stream is opened.
#[cfg(debug_assertions)]
fn a_follows_open_held_at(
    held: &str,
    [first, then]: [scripted::Answer; 2],
    stopped: bool,
) -> (Vec<&'static str>, usize) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let renewals = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&renewals);
    core.renew_credential_with(Box::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        Ok("fresh".into())
    }));
    crate::fault::observe(true);
    let ended_before = crate::fault::reached("request-ended");
    let let_go_before = crate::fault::reached("request-let-go");
    let ready = Arc::new(AtomicBool::new(false));
    let before = server.seen(held).len();
    let wait = scripted::Answer::WaitFor {
        ready: Arc::clone(&ready),
        answer: Box::new(first),
    };
    server.on(held, vec![wait, then]);
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let following = scope.spawn(|| core.follow(&stop, false, |_| {}));
        server.wait_for(held, before + 1, std::time::Duration::from_secs(10));
        if stopped {
            stop.store(true, Ordering::SeqCst);
        }
        ready.store(true, Ordering::SeqCst);
        if !stopped {
            server.wait_for("/events", 1, std::time::Duration::from_secs(10));
            stop.store(true, Ordering::SeqCst);
        }
        following.join().unwrap().unwrap();
    });
    if stopped {
        until("the open's request never ended", || {
            crate::fault::reached("request-ended") == ended_before + 1
        });
        assert_eq!(crate::fault::reached("request-let-go"), let_go_before + 1);
    }
    let sent = ["/types", "/edge-types", "/events"]
        .into_iter()
        .filter(|path| !server.seen(path).is_empty())
        .collect();
    (sent, renewals.load(Ordering::SeqCst))
}

#[cfg(debug_assertions)]
fn root() -> [scripted::Answer; 2] {
    [
        scripted::root(scripted::INSTANCE),
        scripted::root(scripted::INSTANCE),
    ]
}

#[cfg(debug_assertions)]
#[test]
fn a_follow_stopped_while_its_open_reads_the_root_sends_no_catalog_or_stream_request() {
    let (sent, renewals) = a_follows_open_held_at("/", root(), false);
    assert_eq!(sent, ["/types", "/edge-types", "/events"]);
    assert_eq!(renewals, 0);
    let (sent, renewals) = a_follows_open_held_at("/", root(), true);
    assert_eq!(
        sent,
        Vec::<&str>::new(),
        "a request was sent after the stop"
    );
    assert_eq!(renewals, 0);
}

#[cfg(debug_assertions)]
#[test]
fn a_follow_stopped_while_its_open_reads_the_catalog_opens_no_stream() {
    let types = || scripted::certified(scripted::types(&[("core.note", None)]));
    let (sent, _) = a_follows_open_held_at("/types", [types(), types()], false);
    assert_eq!(sent, ["/types", "/edge-types", "/events"]);
    let (sent, _) = a_follows_open_held_at("/types", [types(), types()], true);
    assert_eq!(sent, ["/types"], "a request was sent after the stop");
}

#[cfg(debug_assertions)]
#[test]
fn a_follow_stopped_while_its_open_is_refused_starts_no_renewal() {
    let refused = || {
        [
            scripted::refusal(401, "unauthorized"),
            scripted::certified(scripted::types(&[("core.note", None)])),
        ]
    };
    let (_, renewals) = a_follows_open_held_at("/types", refused(), false);
    assert_eq!(renewals, 1, "the witness renewed no credential");
    let (sent, renewals) = a_follows_open_held_at("/types", refused(), true);
    assert_eq!(renewals, 0, "a renewal started after the stop");
    assert_eq!(sent, ["/types"]);
}

#[test]
fn a_core_dropped_after_a_stopped_root_read_leaves_the_copy_to_open_as_the_writer() {
    let server = Scripted::start();
    answers(&server);
    let released = Arc::new(AtomicBool::new(false));
    server.on(
        "/",
        vec![
            scripted::root(scripted::INSTANCE),
            scripted::Answer::WaitFor {
                ready: Arc::clone(&released),
                answer: Box::new(scripted::root(scripted::INSTANCE)),
            },
        ],
    );
    let (dir, writer, reader) = moved(&server, scripted::INSTANCE);
    drop(reader);
    let stop = AtomicBool::new(false);
    let error = std::thread::scope(|scope| {
        let looking =
            scope.spawn(|| with_resolver(&writer, &stop, |resolver| resolver.resolve(ITEM)));
        server.wait_for("/", 2, std::time::Duration::from_secs(2));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let late = Arc::clone(&released);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            late.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        looking.join().unwrap().unwrap_err()
    });
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    assert!(server.seen(&format!("/items/{ITEM}")).is_empty());
    drop(writer);
    let reopened = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    assert_eq!(reopened.handle(), Handle::Writer);
}

fn bin_answers(server: &Scripted) {
    server.on(
        "/items",
        vec![scripted::json(200, r#"{"data":[],"next_cursor":null}"#)],
    );
}

fn instance_changed(refusal: &CoreError) {
    match refusal {
        CoreError::CopyExpired { reason, .. } => {
            assert_eq!(reason, crate::http::INSTANCE_CHANGED, "{refusal:?}");
        }
        other => panic!("not expired: {other:?}"),
    }
}

#[test]
fn the_bin_is_read_of_no_other_instance_at_the_copys_origin() {
    let server = Scripted::start();
    bin_answers(&server);
    let (dir, writer, reader) = writer_and_reader(&server);

    // The witness: both handles read the bin of the copy's own instance.
    writer.bin(None, None, 50).unwrap();
    reader.bin(None, None, 50).unwrap();
    assert_eq!(server.seen("/items").len(), 2);
    let before = store_bytes(&dir);

    server.on("/", vec![scripted::root(OTHER)]);
    instance_changed(&reader.bin(None, None, 50).unwrap_err());
    assert!(!expired(&writer), "the reader expired the copy");
    assert!(store_bytes(&dir) == before, "the reader changed the store");
    instance_changed(&writer.bin(None, None, 50).unwrap_err());
    assert!(expired(&writer));
    assert_eq!(
        server.seen("/items").len(),
        2,
        "another instance's bin was read"
    );
}

#[test]
fn the_bin_read_again_after_a_renewal_confirms_the_instance_again() {
    for replaced in [false, true] {
        let server = Scripted::start();
        renewed_once(
            &server,
            "/items",
            scripted::json(200, r#"{"data":[],"next_cursor":null}"#),
        );
        if replaced {
            server.on(
                "/",
                vec![scripted::root(scripted::INSTANCE), scripted::root(OTHER)],
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        renew(&core);
        let read = core.bin(None, None, 50);
        assert_eq!(server.seen("/").len(), 2, "replaced {replaced}");
        if !replaced {
            read.unwrap();
            assert_eq!(server.seen("/items").len(), 2, "the witness did not retry");
            continue;
        }
        instance_changed(&read.unwrap_err());
        assert_eq!(
            server.seen("/items").len(),
            1,
            "the retry reached the instance that replaced the first"
        );
        assert!(expired(&core));
    }
}

#[test]
fn a_pin_sends_no_item_id_to_another_instance_at_the_copys_origin() {
    for replaced in [false, true] {
        let server = Scripted::start();
        server.on(
            &format!("/items/{ITEM}"),
            vec![scripted::certified(scripted::refusal(404, "not_found"))],
        );
        server.on(
            "/items",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            ))],
        );
        if replaced {
            server.on("/", vec![scripted::root(OTHER)]);
        }
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");
        let pinned = core.pin(ITEM);
        if !replaced {
            // The witness: the copy's own instance is asked for the item.
            assert_eq!(pinned.unwrap_err().code(), "not_found");
            assert_eq!(server.seen(&format!("/items/{ITEM}")).len(), 1);
            continue;
        }
        instance_changed(&pinned.unwrap_err());
        assert!(server.seen(&format!("/items/{ITEM}")).is_empty());
        assert!(server.seen("/items").is_empty());
        assert!(expired(&core));
    }
}

fn no_titles(server: &Scripted) {
    server.on(
        "/items/titles",
        vec![scripted::json(
            200,
            r#"{"data":[{"name":"","items":[],"more":false}]}"#,
        )],
    );
}

#[test]
fn a_link_by_name_sends_no_name_to_another_instance_and_expires_the_copy() {
    for prefetched in [false, true] {
        let server = Scripted::start();
        no_titles(&server);
        let dir = tempfile::tempdir().unwrap();
        let core = copy_in_keyed(&server, dir.path(), "k");

        // The witness: the copy's own instance is asked for the name.
        with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
            assert!(matches!(
                resolver.resolve("Witness").unwrap(),
                Resolved::Unmatched
            ));
        });
        assert_eq!(server.seen("/items/titles").len(), 1);
        assert_eq!(server.seen("/").len(), 1, "the name was not confirmed");

        server.on("/", vec![scripted::root(OTHER)]);
        let refusal = with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
            if prefetched {
                resolver.prefetch(["Private"]).unwrap_err()
            } else {
                resolver.resolve("Private").unwrap_err()
            }
        });
        instance_changed(&refusal);
        assert_eq!(
            server.seen("/items/titles").len(),
            1,
            "prefetched {prefetched}: a name reached another instance"
        );
        assert!(expired(&core));
    }
}

#[test]
fn a_link_by_name_retried_after_a_renewal_confirms_the_instance_again() {
    let server = Scripted::start();
    renewed_once(
        &server,
        "/items/titles",
        scripted::json(200, r#"{"data":[{"name":"","items":[],"more":false}]}"#),
    );
    server.on(
        "/",
        vec![scripted::root(scripted::INSTANCE), scripted::root(OTHER)],
    );
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    renew(&core);
    let refusal = with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        resolver.resolve("Private").unwrap_err()
    });
    instance_changed(&refusal);
    assert_eq!(server.seen("/").len(), 2);
    assert_eq!(
        server.seen("/items/titles").len(),
        1,
        "the retry reached the instance that replaced the first"
    );
    assert!(expired(&core));
}

#[test]
fn a_resolver_that_met_another_instance_answers_no_later_name() {
    let server = Scripted::start();
    no_titles(&server);
    server.on("/", vec![scripted::root(OTHER)]);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    with_resolver(&core, &crate::NEVER_STOPPED, |resolver| {
        instance_changed(&resolver.prefetch(["First"]).unwrap_err());
        instance_changed(&resolver.resolve("First").unwrap_err());
    });
    assert!(server.seen("/items/titles").is_empty());
}
