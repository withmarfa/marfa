use crate::model::{Verdict, WriteKind};
use crate::scripted::{self, Scripted};
use crate::stop_tests::{copy_in_keyed, created, holding_a_catalog};
use std::path::Path;
use std::sync::Arc;

fn taken(hash: &str) -> scripted::Answer {
    scripted::json(201, &format!(r#"{{"hash":"{hash}","size_bytes":20}}"#))
}

struct Waiting {
    core: Arc<crate::Core>,
    file_id: String,
    r#type: String,
    hash: String,
}

fn file_waiting_on_taken_bytes(server: &Scripted, dir: &Path) -> Waiting {
    let core = copy_in_keyed(server, dir, "k");
    holding_a_catalog(&core);
    let file = dir.join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    server.on("/blobs", vec![taken(&hash)]);
    server.on("/items", vec![scripted::refusal(429, "rate_limited")]);
    assert_eq!(core.drain().unwrap().undelivered, 1);
    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    // What a refused create reads to learn that it made nothing.
    server.on(
        &format!("/items/{file_id}"),
        vec![scripted::certified(scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    Waiting {
        core,
        file_id,
        r#type,
        hash,
    }
}

fn verdicts(core: &crate::Core) -> Vec<(WriteKind, Option<Verdict>, Option<String>)> {
    core.queue()
        .unwrap()
        .into_iter()
        .map(|queued| (queued.kind, queued.verdict, queued.reason))
        .collect()
}

fn absent() -> scripted::Answer {
    scripted::refusal(404, "blob_not_found")
}

/// A refused create reads the bin to learn whether it made anything.
pub(crate) fn empty_bin() -> scripted::Answer {
    scripted::certified(scripted::json(200, r#"{"data":[],"next_cursor":null}"#))
}

fn uploads_sent(server: &Scripted) -> usize {
    server.seen("/blobs").len()
}

#[test]
fn sends_the_bytes_again_when_the_server_no_longer_holds_them_then_the_file() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting {
        core,
        file_id,
        r#type,
        hash,
    } = file_waiting_on_taken_bytes(&server, dir.path());
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![absent(), scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);

    let report = core.drain().unwrap();

    assert_eq!(uploads_sent(&server), 2, "the bytes were not sent again");
    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(
        verdicts(&core),
        [
            (WriteKind::UploadBlob, Some(Verdict::Accepted), None),
            (WriteKind::CreateItem, Some(Verdict::Accepted), None),
        ]
    );
    assert_eq!(
        report
            .verdicts
            .iter()
            .filter(|told| told.kind == WriteKind::CreateItem)
            .map(|told| told.verdict)
            .collect::<Vec<_>>(),
        [Some(Verdict::Accepted)],
        "{report:?}"
    );
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(!core.blob_held(&hash).unwrap());
}

#[test]
fn refuses_the_file_when_the_bytes_sent_again_are_refused_too_and_keeps_them() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, hash, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on("/items", vec![absent(), absent(), empty_bin()]);

    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 2);
    assert_eq!(
        verdicts(&core)[1],
        (
            WriteKind::CreateItem,
            Some(Verdict::Refused),
            Some("blob_not_found".into())
        )
    );
    // Final: nothing goes again.
    let sent = server.seen("/items").len();
    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 2);
    assert_eq!(server.seen("/items").len(), sent);

    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&hash).unwrap(),
        "a trim let go of the only copy of a file the server refused for its bytes"
    );
}

#[test]
fn clearing_answers_keeps_the_upload_of_a_file_refused_for_its_bytes_until_it_is_discarded() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, hash, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on("/items", vec![absent(), absent(), empty_bin()]);
    core.drain().unwrap();
    let file = core.queue().unwrap()[1].id.clone();

    core.forget_answered().unwrap();
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&hash).unwrap(),
        "clearing answers let a trim take the only copy: {:?}",
        verdicts(&core)
    );

    assert!(core.discard(&file).unwrap());
    core.forget_answered().unwrap();
    assert!(core.queue().unwrap().is_empty(), "{:?}", verdicts(&core));
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(!core.blob_held(&hash).unwrap());
}

#[test]
fn a_restart_between_the_bytes_and_the_file_sends_the_bytes_no_third_time() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on(
        "/items",
        vec![absent(), scripted::refusal(429, "rate_limited")],
    );
    assert_eq!(core.drain().unwrap().undelivered, 1);
    assert_eq!(uploads_sent(&server), 2);
    drop(core);

    let core = copy_in_keyed(&server, dir.path(), "k");
    server.on("/items", vec![absent(), empty_bin()]);
    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 2, "the bytes went a third time");
    assert_eq!(verdicts(&core)[1].1, Some(Verdict::Refused));
}

#[test]
fn refuses_the_file_as_before_when_the_copy_no_longer_holds_the_bytes() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, hash, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    let hex = crate::blob::hex_of(&hash).unwrap();
    std::fs::remove_file(dir.path().join("core.sqlite.blobs").join(hex)).unwrap();
    server.on("/items", vec![absent(), empty_bin()]);

    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 1);
    assert_eq!(verdicts(&core)[1].1, Some(Verdict::Refused));
}

#[test]
fn the_file_waits_while_its_bytes_cannot_go_again_and_is_refused_with_them() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting {
        core,
        file_id,
        r#type,
        hash,
    } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on("/items", vec![absent()]);
    server.on(
        "/blobs",
        vec![scripted::refusal(503, "service_unavailable")],
    );

    let report = core.drain().unwrap();
    assert_eq!(report.undelivered, 1, "{report:?}");
    assert_eq!(uploads_sent(&server), 2);
    let queue = verdicts(&core);
    assert_eq!(queue[0].1, None);
    assert_ne!(queue[1].1, Some(Verdict::Refused), "{queue:?}");
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(core.blob_held(&hash).unwrap());

    // The next drain sends the bytes before the file.
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/blobs", vec![taken(&hash)]);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    assert_eq!(uploads_sent(&server), 3);
    assert_eq!(verdicts(&core)[1].1, Some(Verdict::Accepted));
}

#[test]
fn refuses_the_file_naming_the_upload_when_the_bytes_sent_again_are_refused() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on("/items", vec![absent(), empty_bin()]);
    server.on("/blobs", vec![scripted::refusal(413, "payload_too_large")]);

    core.drain().unwrap();
    assert_eq!(
        verdicts(&core),
        [
            (
                WriteKind::UploadBlob,
                Some(Verdict::Refused),
                Some("payload_too_large".into())
            ),
            (
                WriteKind::CreateItem,
                Some(Verdict::Refused),
                Some("the upload_blob it waits for was refused".into())
            ),
        ]
    );
}

#[test]
fn one_sending_of_the_bytes_serves_two_files_that_name_them() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    holding_a_catalog(&core);
    let mut files = Vec::new();
    for name in ["photo.txt", "copy.txt"] {
        let file = dir.path().join(name);
        std::fs::write(&file, b"the bytes of a photo").unwrap();
        let added = core
            .add_file(&file, &crate::Attachment::default(), &[])
            .unwrap();
        files.push(added.item.item_id.unwrap());
    }
    let hash = core.queue().unwrap()[0].blob.clone().unwrap();
    server.on("/blobs", vec![taken(&hash)]);
    // Counted, not environmental, so the pass goes on to the second upload.
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 2);

    let mut items = vec![absent(), absent()];
    for id in &files {
        let r#type = core.get(id).unwrap().unwrap().r#type;
        let (receipt, read) = created(id, &r#type);
        items.push(scripted::json(201, &receipt));
        server.on(&format!("/items/{id}"), vec![read]);
    }
    server.on("/items", items);
    let report = core.drain().unwrap();
    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(
        uploads_sent(&server),
        3,
        "the bytes went once for each file"
    );
    assert!(
        verdicts(&core)
            .iter()
            .all(|(_, verdict, _)| *verdict == Some(Verdict::Accepted)),
        "{:?}",
        verdicts(&core)
    );
}

/// What `set_aside` records for an upload that fails alone.
pub(crate) fn set_aside(core: &crate::Core, id: &str) {
    crate::store::record_verdict(
        &core.conn().unwrap(),
        id,
        &crate::store::Answered {
            verdict: Verdict::Blocked,
            reason: Some(crate::model::BlockedReason::FailingAlone.as_str()),
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
}

#[test]
fn withdrawing_bytes_sent_again_refuses_the_file_sent_before_and_keeps_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let Waiting { core, file_id, .. } = file_waiting_on_taken_bytes(&server, dir.path());
    server.on("/items", vec![absent()]);
    server.on(
        "/blobs",
        vec![scripted::refusal(503, "service_unavailable")],
    );
    core.drain().unwrap();
    let queue = core.queue().unwrap();
    let (upload, file) = (queue[0].clone(), queue[1].clone());
    assert_eq!(upload.verdict, None, "the bytes were not made to go again");
    assert!(!crate::store::unsent(&core.conn().unwrap(), &file.id).unwrap());
    // What a withdrawal reads to learn whether the create made anything.
    server.on("/items", vec![empty_bin()]);
    server.on(
        &format!("/items/{file_id}"),
        vec![scripted::certified(scripted::refusal(
            404,
            "item_not_found",
        ))],
    );

    set_aside(&core, &upload.id);
    assert_eq!(core.withdraw(&upload.id).unwrap(), vec![upload.id.clone()]);

    let after = core.queue().unwrap();
    assert_eq!(
        after
            .iter()
            .map(|queued| (queued.kind, queued.verdict, queued.reason.clone()))
            .collect::<Vec<_>>(),
        [(
            WriteKind::CreateItem,
            Some(Verdict::Refused),
            Some("the upload_blob it waits for was withdrawn".into())
        )],
        "the file still waits on bytes the queue no longer holds"
    );
    assert_eq!(
        after[0].body, file.body,
        "the refused file lost its content"
    );
    let (items, blobs) = (server.seen("/items").len(), uploads_sent(&server));
    core.drain().unwrap();
    assert_eq!(
        (server.seen("/items").len(), uploads_sent(&server)),
        (items, blobs),
        "a write refused behind a withdrawn upload went again"
    );
    assert!(!core.release(&file.id).unwrap());
}

#[cfg(unix)]
#[test]
fn sets_aside_an_upload_whose_bytes_fail_to_open_alike_in_successive_drains() {
    use crate::model::BlockedReason;
    use std::os::unix::fs::PermissionsExt;
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "k");
    holding_a_catalog(&core);
    let file = dir.path().join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    let held = dir
        .path()
        .join("core.sqlite.blobs")
        .join(hash.trim_start_matches("sha256:"));
    std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o000)).unwrap();
    assert!(
        std::fs::File::open(&held).is_err(),
        "the bytes can still be opened, so nothing here is about bytes that cannot"
    );
    let upload = |core: &crate::Core| {
        core.queue()
            .unwrap()
            .into_iter()
            .find(|queued| queued.kind == WriteKind::UploadBlob)
            .unwrap()
    };
    for _ in 0..2 {
        let report = core.drain().unwrap();
        assert_eq!(report.undelivered, 1, "{report:?}");
        assert_eq!(upload(&core).verdict, None);
    }
    // Five minutes on, in the third drain.
    {
        let conn = core.conn().unwrap();
        conn.execute(
            "UPDATE queue SET environmental_since = environmental_since - 360000 WHERE kind = 'upload_blob'",
            [],
        )
        .unwrap();
    }
    let report = core.drain().unwrap();
    let set_aside = upload(&core);
    assert_eq!(
        (set_aside.verdict, set_aside.blocked_reason()),
        (Some(Verdict::Blocked), Some(BlockedReason::FailingAlone)),
        "{report:?}"
    );
    assert!(set_aside
            .last_failure
            .as_ref()
            .and_then(|failure| failure.text.as_deref())
            .is_some_and(|text| text.contains("could not be opened")));
    assert!(set_aside.withdrawable());
    assert!(uploads_sent(&server) == 0);
    // The cause is fixed and the write released: the bytes go.
    std::fs::set_permissions(&held, std::fs::Permissions::from_mode(0o644)).unwrap();
    server.on("/blobs", vec![taken(&hash)]);
    server.on("/items", vec![scripted::refusal(429, "rate_limited")]);
    assert!(core.release(&set_aside.id).unwrap());
    core.drain().unwrap();
    assert_eq!(uploads_sent(&server), 1);
}
