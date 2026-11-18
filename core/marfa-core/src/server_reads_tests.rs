//! A read that names an item to the server confirms the copy's instance
//! first, and a reading handle writes nothing for any request it sends.

use std::sync::Arc;

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

/// Every byte of the store's database and its write-ahead log.
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
            let mut resolver = Resolver::new(core, &catalog, &Placements);
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

        // The witness: the copy's own instance is sent the item.
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

        // The witness: the writer's own read expires it.
        assert_eq!(
            read_a_table(&writer, door).unwrap_err().code(),
            "copy_expired",
            "{name}"
        );
        assert!(expired(&writer), "{name}");
    }
}

#[test]
fn a_link_lookup_confirms_the_instance_once_for_every_id_it_asks() {
    let server = Scripted::start();
    answers(&server);
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    let other = "01a1011a-4902-76cf-a4a9-88e99c038c8e";
    server.on(
        &format!("/items/{other}"),
        vec![scripted::refusal(404, "x")],
    );
    let catalog = crate::catalog::load(&core.conn().unwrap()).unwrap();
    let mut resolver = Resolver::new(&core, &catalog, &Placements);
    let roots = server.seen("/").len();
    assert!(matches!(
        resolver.resolve(ITEM).unwrap(),
        Resolved::Unmatched
    ));
    assert!(matches!(
        resolver.resolve(other).unwrap(),
        Resolved::Unmatched
    ));
    assert_eq!(server.seen("/").len(), roots + 1);
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

    // The witness: the writer's own renewal is written down, and a renewal
    // after the reader's still succeeds.
    renewed();
    writer.renew_credential_with(Box::new(|_| Ok("fresh".into())));
    writer.http().unwrap().types().unwrap();
    assert_eq!(sent_as(&writer), fresh);
    renewed();
    writer.renew_credential_with(Box::new(|_| Ok("fresher".into())));
    writer.http().unwrap().types().unwrap();
    assert_eq!(writer.http().unwrap().authorization(), "Bearer fresh");
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
    // Confirmed once: the next request asks no more.
    let roots = server.seen("/").len();
    reader.http().unwrap().types().unwrap();
    assert_eq!(server.seen("/").len(), roots);

    // The witness: the writer records the move it confirms.
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
    // The witness: the writer's own request at the same origin is refused alike.
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
