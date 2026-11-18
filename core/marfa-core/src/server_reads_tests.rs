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
    let error = std::thread::scope(|scope| {
        let settling = scope.spawn(|| core.settle_bodies(&crate::NEVER_STOPPED));
        server.wait_for("/", 1, std::time::Duration::from_secs(2));
        meanwhile(core);
        settling.join().unwrap().unwrap_err()
    });
    assert!(server.seen(&format!("/items/{ITEM}")).is_empty());
    error
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

#[test]
fn a_stop_during_the_final_link_read_ends_canceled_without_waiting_or_renewing() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let renewals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&renewals);
    core.renew_credential_with(Box::new(move |_| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok("fresh".into())
    }));
    let path = format!("/items/{ITEM}");
    server.on(
        &path,
        vec![scripted::Answer::Slow {
            after: std::time::Duration::from_millis(600),
            answer: Box::new(scripted::refusal(401, "unauthorized")),
        }],
    );
    with_waiting_link(&core);
    let stop = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let error = std::thread::scope(|scope| {
        let settling = scope.spawn(|| core.settle_bodies(&stop));
        server.wait_for(&path, 1, std::time::Duration::from_secs(2));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        settling.join().unwrap().unwrap_err()
    });
    assert!(matches!(error, CoreError::Canceled), "{error:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_millis(550),
        "the stop waited for the reply: {:?}",
        started.elapsed()
    );
    std::thread::sleep(std::time::Duration::from_millis(900));
    assert_eq!(renewals.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(server.seen(&path).len(), 1, "the late 401 was retried");
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
