//! The bytes of attachments: which the file cache keeps, how a fetch of
//! them goes on past one file's failure, and what it writes down of each.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::catalog::Indexing;
use crate::file_cache::{FileBudget, NotHeldReason};
use crate::scripted::{self, Answer, Scripted};
use crate::store::testing::{wire_edge, wire_item};
use crate::{Core, CoreError, blob, store};

fn file(core: &Core, id: &str, bytes: &[u8]) -> String {
    let hash = blob::name_of(bytes);
    let row = wire_item(
        id,
        "core.file",
        "active",
        "2026-01-01T00:00:00Z",
        json!({ "blob_ref": hash, "size_bytes": bytes.len(), "mime_type": "text/plain" }),
    );
    store::upsert_item(&core.conn().unwrap(), &row, None, &Indexing::default()).unwrap();
    hash
}

fn note(core: &Core, id: &str) {
    let row = wire_item(
        id,
        "core.note",
        "active",
        "2026-01-01T00:00:00Z",
        json!({ "title": id }),
    );
    store::upsert_item(&core.conn().unwrap(), &row, None, &Indexing::default()).unwrap();
}

fn attach(core: &Core, edge: &str, file: &str, item: &str) {
    store::upsert_edge(
        &core.conn().unwrap(),
        &wire_edge(edge, file, item, "attached-to"),
    )
    .unwrap();
}

fn hold(core: &Core, dir: &Path, bytes: &[u8]) -> String {
    let path = dir.join(format!("{}.txt", bytes.len()));
    std::fs::write(&path, bytes).unwrap();
    core.cache()
        .unwrap()
        .take_reader(&path, std::fs::File::open(&path).unwrap())
        .unwrap()
        .hash
}

fn kept(core: &Core) -> HashSet<String> {
    store::kept_attachments(&core.conn().unwrap()).unwrap()
}

fn hex(hash: &str) -> String {
    blob::hex_of(hash).unwrap().to_string()
}

/// What the state report says of the attachments not held, by why.
fn not_held(core: &Core) -> Vec<(NotHeldReason, u64)> {
    core.file_cache()
        .unwrap()
        .attachments
        .unwrap()
        .not_held_by_reason
        .iter()
        .map(|why| (why.reason, why.attachments))
        .collect()
}

fn serve(server: &Scripted, bytes: &[u8]) -> String {
    let hash = blob::name_of(bytes);
    let link = blob::tests::linking(bytes.to_vec(), false);
    server.on(
        &format!("/blobs/{hash}/url"),
        vec![scripted::json(200, &format!(r#"{{"url":"{link}"}}"#))],
    );
    hash
}

fn limited(seconds: u64) -> Answer {
    Answer::Json {
        status: 429,
        body: r#"{"error":{"code":"rate_limited","message":"scripted"}}"#.into(),
        headers: vec![("Retry-After".into(), seconds.to_string())],
    }
}

#[test]
fn the_bytes_attachments_keep_follow_each_change_and_only_grow_while_the_copy_is_not_whole() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    note(&core, "note");
    let photo = file(&core, "photo", b"photo bytes");
    let scan = file(&core, "scan", b"scan bytes");
    assert!(
        kept(&core).is_empty(),
        "a file attached to nothing was kept"
    );
    attach(&core, "e1", "photo", "note");
    attach(&core, "e2", "scan", "note");
    assert_eq!(kept(&core), HashSet::from([hex(&photo), hex(&scan)]));
    store::delete_edge(&core.conn().unwrap(), "e2").unwrap();
    assert_eq!(kept(&core), HashSet::from([hex(&photo)]));
    store::set_item_state(&core.conn().unwrap(), "note", crate::ItemState::Trashed).unwrap();
    assert!(
        kept(&core).is_empty(),
        "the bytes of a file attached to a binned item were kept"
    );
    store::set_item_state(&core.conn().unwrap(), "note", crate::ItemState::Active).unwrap();
    assert_eq!(kept(&core), HashSet::from([hex(&photo)]));

    // From the start of a hydration the rows go, and the bytes stay kept
    // until one completes, which keeps only what the whole copy attaches.
    {
        let conn = core.conn().unwrap();
        store::attachments_start_growing(&conn).unwrap();
        store::clear_slice(&conn).unwrap();
    }
    note(&core, "other");
    file(&core, "scan", b"scan bytes");
    attach(&core, "e3", "scan", "other");
    store::delete_edge(&core.conn().unwrap(), "e3").unwrap();
    assert_eq!(kept(&core), HashSet::from([hex(&photo), hex(&scan)]));
    attach(&core, "e3", "scan", "other");
    store::attachments_whole(&core.conn().unwrap()).unwrap();
    assert_eq!(kept(&core), HashSet::from([hex(&scan)]));
}

#[test]
fn a_hydration_that_expires_part_way_keeps_the_bytes_of_attachments_and_trims_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    core.set_file_budget(FileBudget::KeepAll).unwrap();
    let photo = hold(&core, dir.path(), b"photo bytes");
    let loose = hold(&core, dir.path(), b"bytes nothing attaches");
    note(&core, "note");
    file(&core, "photo", b"photo bytes");
    attach(&core, "e1", "photo", "note");
    {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS).unwrap();
        store::attachments_start_growing(&conn).unwrap();
        store::clear_slice(&conn).unwrap();
        crate::reach::expire(&conn).unwrap();
        assert!(store::hydration_complete(&conn).unwrap());
    }
    assert_eq!(
        core.file_cache().unwrap().attachments,
        None,
        "attachments were reported from a copy that is not whole"
    );
    // The budget holds while the copy is not whole: the loose bytes go.
    assert_eq!(core.set_file_budget(FileBudget::Bytes(0)).unwrap(), 22);
    assert!(!core.blob_held(&loose).unwrap());
    assert!(
        core.blob_held(&photo).unwrap(),
        "a trim after a hydration expired part way took the bytes of an attachment"
    );
    // The witness: once a hydration completes without the file, the same
    // trim takes its bytes.
    store::attachments_whole(&core.conn().unwrap()).unwrap();
    assert_eq!(core.trim_files().unwrap(), 11);
    assert!(!core.blob_held(&photo).unwrap());
}

#[test]
fn an_attachment_made_while_a_trim_reads_what_to_keep_waits_for_the_trim() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    note(&core, "note");
    file(&core, "photo", b"photo bytes");
    let photo = hold(&core, dir.path(), b"photo bytes");
    let point = format!("attachments-read:{:p}", &core);
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let trim = scope.spawn(|| {
            let taken = core.trim_files().unwrap();
            (taken, Instant::now())
        });
        let waited = Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "the trim never read the bytes attachments keep"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let edge = scope.spawn(|| {
            attach(&core, "e1", "photo", "note");
            Instant::now()
        });
        // Long enough for an edge that is not held back to be written.
        std::thread::sleep(Duration::from_millis(200));
        crate::fault::release(&point);
        let (taken, trimmed) = trim.join().unwrap();
        let attached = edge.join().unwrap();
        assert_eq!(taken, 11);
        assert!(
            attached >= trimmed,
            "an attachment was made between the trim's read of what to keep and its removal"
        );
    });
    assert!(!core.blob_held(&photo).unwrap());
    assert_eq!(kept(&core), HashSet::from([hex(&photo)]));
}

#[test]
fn a_fetch_of_attachments_waits_out_a_short_rate_limit_and_stops_at_a_long_one() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    note(&core, "note");
    let small = file(&core, "small", b"small");
    file(&core, "large", b"the larger file");
    attach(&core, "e1", "small", "note");
    attach(&core, "e2", "large", "note");
    let link = blob::tests::linking(b"small".to_vec(), false);
    server.on(
        &format!("/blobs/{small}/url"),
        vec![
            limited(1),
            scripted::json(200, &format!(r#"{{"url":"{link}"}}"#)),
        ],
    );
    serve(&server, b"the larger file");
    let started = Instant::now();
    let fetched = core.fetch_kept_until(&AtomicBool::new(false)).unwrap();
    assert_eq!(fetched.fetched, 2);
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "no wait was made"
    );
    assert_eq!(not_held(&core), []);

    // A wait longer than a fetch waits stops it, and says why of every file
    // it left.
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    note(&core, "note");
    let small = file(&core, "small", b"small");
    let large = file(&core, "large", b"the larger file");
    attach(&core, "e1", "small", "note");
    attach(&core, "e2", "large", "note");
    server.on(&format!("/blobs/{small}/url"), vec![limited(120)]);
    serve(&server, b"the larger file");
    let started = Instant::now();
    let fetched = core.fetch_kept_until(&AtomicBool::new(false)).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "the long wait was made"
    );
    assert_eq!(fetched.fetched, 0);
    assert_eq!(not_held(&core), [(NotHeldReason::RateLimited, 2)]);
    assert!(server.seen(&format!("/blobs/{large}/url")).is_empty());

    // A stop ends a wait.
    server.on(&format!("/blobs/{small}/url"), vec![limited(30)]);
    let stop = Arc::new(AtomicBool::new(false));
    let raise = Arc::clone(&stop);
    let raising = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        raise.store(true, Ordering::Relaxed);
    });
    let started = Instant::now();
    assert!(matches!(
        core.fetch_kept_until(&stop),
        Err(CoreError::Canceled)
    ));
    assert!(started.elapsed() < Duration::from_secs(10));
    raising.join().unwrap();
}

#[test]
fn a_fetch_through_a_read_writes_down_why_an_attachment_is_not_held_until_it_is() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    note(&core, "note");
    let photo = file(&core, "photo", b"photo bytes");
    attach(&core, "e1", "photo", "note");
    server.on(
        &format!("/blobs/{photo}/url"),
        vec![scripted::refusal(404, "blob_not_found")],
    );
    assert!(matches!(
        core.blob(&photo),
        Err(CoreError::BytesAbsent { .. })
    ));
    assert_eq!(not_held(&core), [(NotHeldReason::Absent, 1)]);
    serve(&server, b"photo bytes");
    core.blob(&photo).unwrap();
    assert_eq!(not_held(&core), []);
    assert!(
        store::attachment_misses(&core.conn().unwrap())
            .unwrap()
            .is_empty()
    );

    // What was written down goes once the file is no attachment.
    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    server.on(
        &format!("/blobs/{photo}/url"),
        vec![scripted::refusal(404, "blob_not_found")],
    );
    store::delete_edge(&core.conn().unwrap(), "e1").unwrap();
    core.trim_files().unwrap();
    assert!(!core.blob_held(&photo).unwrap());
    attach(&core, "e1", "photo", "note");
    assert!(core.blob(&photo).is_err());
    assert_eq!(not_held(&core), [(NotHeldReason::Absent, 1)]);
    store::delete_edge(&core.conn().unwrap(), "e1").unwrap();
    attach(&core, "e1", "photo", "note");
    assert_eq!(not_held(&core), [(NotHeldReason::NotFetched, 1)]);
}

#[cfg(unix)]
#[test]
fn a_fetch_of_attachments_goes_on_past_a_held_file_it_cannot_read() {
    use std::os::unix::fs::PermissionsExt;
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    note(&core, "note");
    let sealed = file(&core, "sealed", b"sealed");
    let fetched = file(&core, "fetched", b"fetched later");
    attach(&core, "e1", "sealed", "note");
    attach(&core, "e2", "fetched", "note");
    hold(&core, dir.path(), b"sealed");
    serve(&server, b"fetched later");
    let path = dir.path().join("core.sqlite.blobs").join(hex(&sealed));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = std::fs::File::open(&path).is_err();
    let report = core.fetch_kept_until(&AtomicBool::new(false));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(unreadable, "the held file could still be read");
    assert_eq!(report.unwrap().fetched, 1);
    assert!(core.blob_held(&fetched).unwrap());
    assert_eq!(
        store::attachment_misses(&core.conn().unwrap())
            .unwrap()
            .get(&hex(&sealed))
            .map(String::as_str),
        Some("failed")
    );
}
