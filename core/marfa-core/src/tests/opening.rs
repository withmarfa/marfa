use super::*;

#[test]
fn a_server_debug_shows_its_url_and_never_its_key() {
    let server = Server {
        url: "https://marfa.example".into(),
        key: "marfa_k1_debug_witness".into(),
    };
    let shown = format!("{server:?} {server:#?}");
    assert!(shown.contains("https://marfa.example"), "{shown}");
    assert!(!shown.contains("marfa_k1_debug_witness"), "{shown}");
}

/// Another connection holding a write transaction on the store, until
/// it is let go.
fn holding_a_write(path: &Path) -> rusqlite::Connection {
    let other = rusqlite::Connection::open(path).unwrap();
    other
        .execute_batch("BEGIN IMMEDIATE; INSERT OR REPLACE INTO meta VALUES ('held', 'x');")
        .unwrap();
    other
}

#[test]
fn an_open_with_nothing_to_write_opens_while_another_connection_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    drop(Core::open(&path, None).unwrap());
    let other = holding_a_write(&path);

    let started = std::time::Instant::now();
    let writer = Core::open(&path, None).unwrap();
    assert_eq!(writer.handle(), Handle::Writer);
    let reader = Core::open(&path, None).unwrap();
    assert_eq!(reader.handle(), Handle::Reader);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "the opens waited {:?} on a write they did not need",
        started.elapsed()
    );
    other.execute_batch("COMMIT").unwrap();
    drop((writer, reader));

    let watching = rusqlite::Connection::open(&path).unwrap();
    let before = store::data_version(&watching).unwrap();
    drop(Core::open(&path, None).unwrap());
    assert_eq!(
        store::data_version(&watching).unwrap(),
        before,
        "an open with nothing to change committed a write"
    );
}

#[test]
fn an_open_that_writes_waits_for_another_connections_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let shipped = {
        let core = Core::open(&path, None).unwrap();
        let conn = core.conn().unwrap();
        let shipped = store::edge_type_rows(&conn).unwrap();
        // As a build that ships an edge type the store does not hold.
        conn.execute(
            "DELETE FROM edge_types WHERE id = (SELECT max(id) FROM edge_types)",
            [],
        )
        .unwrap();
        shipped
    };
    // The witness for the other test's unchanged data_version: an open that writes moves it.
    let watching = rusqlite::Connection::open(&path).unwrap();
    let before = store::data_version(&watching).unwrap();
    let other = holding_a_write(&path);
    let held = std::time::Duration::from_millis(300);
    let letting_go = std::thread::spawn(move || {
        std::thread::sleep(held);
        other.execute_batch("COMMIT").unwrap();
    });

    let started = std::time::Instant::now();
    let core = Core::open(&path, None).unwrap();
    assert!(
        started.elapsed() >= held,
        "the open wrote under another's write"
    );
    letting_go.join().unwrap();
    assert_ne!(
        store::data_version(&watching).unwrap(),
        before,
        "an open that changed the catalog committed nothing"
    );
    assert_eq!(
        store::edge_type_rows(&core.conn().unwrap()).unwrap(),
        shipped
    );
}

#[test]
fn the_writer_sweeps_old_half_written_copies_when_it_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let blobs = dir.path().join("core.sqlite.blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    let old = blobs.join(".incoming-old");
    let young = blobs.join(".incoming-young");
    std::fs::write(&old, b"half").unwrap();
    std::fs::write(&young, b"half").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - 2 * INCOMING_GRACE)
        .unwrap();
    let _writer = Core::open(&path, None).unwrap();
    assert!(
        !old.exists(),
        "a half-written copy older than the grace survived the writer's open"
    );
    assert!(
        young.exists(),
        "a copy something may still be writing was taken"
    );
}

#[test]
fn an_origin_only_copy_opens_offline_but_refuses_to_send_to_another_origin() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let core = Core::open(&path, unreachable_server("http://one.test:8600/")).unwrap();
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_SERVER_ORIGIN, "http://one.test:8600").unwrap();
    }
    assert!(Core::open(&path, unreachable_server("HTTP://ONE.test:8600")).is_ok());
    assert!(Core::open(&path, None).is_ok());
    assert_eq!(
        Core::open(&path, unreachable_server("http://two.test:8600"))
            .unwrap()
            .http()
            .unwrap()
            .types()
            .err(),
        Some(CoreError::WrongServer {
            expected: "http://one.test:8600".into(),
            got: "http://two.test:8600".into()
        })
    );
}
